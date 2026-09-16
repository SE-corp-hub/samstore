// Cart orchestration — server-authoritative guest carts.
// Rules enforced here (per AGENTS.md):
//   • cart token generated server-side, high entropy
//   • cart bound to ONE store (first product added sets the store; cross-store add = conflict)
//   • stock checked against quantityOnHand - quantityReserved
//   • unit price snapshotted from the live catalog at add-time

import { randomBytes } from "node:crypto";
import type { ApiError, CartWithItemsDTO } from "@sam-store/contracts";
import type {
  CartRecord,
  CartRepository,
  CatalogRepository,
  ProductRecord,
} from "../persistence/repositories.js";
import { randomId } from "../persistence/repositories.js";

export type CartResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** DI token — explicit, matches CHECKOUT_SERVICE pattern. */
export const CART_SERVICE = Symbol("CART_SERVICE");

const CART_TOKEN_BYTES = 24; // 192 bits of entropy
const CART_TTL_MS = 7 * 86_400_000; // 7 days — abandoned carts are released after this

export function generateCartToken(): string {
  return `cart_${randomBytes(CART_TOKEN_BYTES).toString("base64url")}`;
}

export class CartService {
  constructor(
    private readonly carts: CartRepository,
    private readonly catalog: CatalogRepository,
  ) {}

  private toDTO(cart: CartRecord, products: Map<string, ProductRecord>): CartWithItemsDTO {
    const items = cart.lines.map((l) => {
      const p = products.get(l.productId);
      return {
        productId: l.productId,
        sku: p?.sku ?? "UNKNOWN",
        name: p?.name ?? "Unknown product",
        unitPriceMinor: l.unitPriceMinor,
        quantity: l.quantity,
        lineTotalMinor: l.unitPriceMinor * l.quantity,
      };
    });
    return {
      token: cart.token,
      storeId: cart.storeId,
      status: cart.status,
      items,
      subtotalMinor: items.reduce((s, i) => s + i.lineTotalMinor, 0),
    };
  }

  async createCart(): Promise<CartResult<{ token: string }>> {
    const token = generateCartToken();
    const cart: CartRecord = {
      id: randomId(),
      storeId: "", // bound on first add
      token,
      status: "OPEN",
      expiresAt: new Date(Date.now() + CART_TTL_MS),
      lines: [],
    };
    await this.carts.create(cart);
    return { ok: true, value: { token } };
  }

  async getCart(token: string): Promise<CartResult<CartWithItemsDTO>> {
    const cart = await this.carts.findByToken(token);
    if (!cart) return { ok: false, error: { type: "not_found", message: "Cart not found" } };
    if (cart.expiresAt && cart.expiresAt < new Date()) {
      return { ok: false, error: { type: "conflict", message: "This cart has expired — please start a new one" } };
    }
    const products = await this.loadProducts(cart);
    return { ok: true, value: this.toDTO(cart, products) };
  }

  async addItem(
    token: string,
    productId: string,
    quantity: number,
  ): Promise<CartResult<CartWithItemsDTO>> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { ok: false, error: { type: "validation", errors: ["quantity must be a positive integer"] } };
    }
    if (quantity > 99) {
      return { ok: false, error: { type: "validation", errors: ["quantity cannot exceed 99"] } };
    }

    let cart = await this.carts.findByToken(token);
    if (!cart) return { ok: false, error: { type: "not_found", message: "Cart not found" } };
    if (cart.status !== "OPEN") {
      return { ok: false, error: { type: "conflict", message: "Cart is no longer open" } };
    }
    if (cart.expiresAt && cart.expiresAt < new Date()) {
      return { ok: false, error: { type: "conflict", message: "This cart has expired — please start a new one" } };
    }

    const product = await this.catalog.getProductById(productId);
    if (!product) {
      return { ok: false, error: { type: "not_found", message: "Product not found" } };
    }

    // Cross-store guard: a cart may only ever contain ONE store's products.
    if (cart.storeId && product.storeId !== cart.storeId) {
      return { ok: false, error: { type: "conflict", message: "Cannot add products from a different store to this cart" } };
    }
    if (!product.isActive) {
      return { ok: false, error: { type: "conflict", message: "Product is not available" } };
    }

    // Stock check: available = onHand - reserved - already-in-cart qty
    const available = product.quantityOnHand - product.quantityReserved;
    const existingQty = cart.lines.find((l) => l.productId === productId)?.quantity ?? 0;
    if (existingQty + quantity > available) {
      return {
        ok: false,
        error: { type: "conflict", message: `Only ${available} in stock` },
      };
    }

    if (!cart.storeId) {
      // First add binds the cart to the store.
      await this.carts.save({ ...cart, storeId: product.storeId });
      cart = { ...cart, storeId: product.storeId };
    }

    await this.carts.addItem(cart.id, cart.storeId, productId, quantity, product.priceMinor);
    const fresh = (await this.carts.findByToken(token))!;
    const products = await this.loadProducts(fresh);
    return { ok: true, value: this.toDTO(fresh, products) };
  }

  async updateQuantity(
    token: string,
    productId: string,
    quantity: number,
  ): Promise<CartResult<CartWithItemsDTO>> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { ok: false, error: { type: "validation", errors: ["quantity must be a positive integer"] } };
    }
    if (quantity > 99) {
      return { ok: false, error: { type: "validation", errors: ["quantity cannot exceed 99"] } };
    }
    const cart = await this.carts.findByToken(token);
    if (!cart) return { ok: false, error: { type: "not_found", message: "Cart not found" } };
    if (cart.status !== "OPEN") {
      return { ok: false, error: { type: "conflict", message: "Cart is no longer open" } };
    }
    const line = cart.lines.find((l) => l.productId === productId);
    if (!line) return { ok: false, error: { type: "not_found", message: "Item not in cart" } };

    const product = (await this.catalog.getProductsByIds(cart.storeId, [productId]))[0] ?? null;
    if (product) {
      const available = product.quantityOnHand - product.quantityReserved;
      if (quantity > available) {
        return { ok: false, error: { type: "conflict", message: `Only ${available} in stock` } };
      }
    }

    await this.carts.updateItemQuantity(cart.id, productId, quantity);
    const fresh = (await this.carts.findByToken(token))!;
    const products = await this.loadProducts(fresh);
    return { ok: true, value: this.toDTO(fresh, products) };
  }

  async removeItem(token: string, productId: string): Promise<CartResult<CartWithItemsDTO>> {
    const cart = await this.carts.findByToken(token);
    if (!cart) return { ok: false, error: { type: "not_found", message: "Cart not found" } };
    await this.carts.removeItem(cart.id, productId);
    const fresh = (await this.carts.findByToken(token))!;
    const products = await this.loadProducts(fresh);
    return { ok: true, value: this.toDTO(fresh, products) };
  }

  private async loadProducts(cart: CartRecord): Promise<Map<string, ProductRecord>> {
    if (cart.storeId === "" || cart.lines.length === 0) return new Map();
    const products = await this.catalog.getProductsByIds(
      cart.storeId,
      cart.lines.map((l) => l.productId),
    );
    return new Map(products.map((p) => [p.id, p]));
  }
}