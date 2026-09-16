// Cart orchestration — server-authoritative guest carts.
// Rules enforced here (per AGENTS.md):
//   • cart token generated server-side, high entropy
//   • cart bound to ONE store (first product added sets the store; cross-store add = conflict)
//   • stock checked against quantityOnHand - quantityReserved (product OR variant, P2a)
//   • unit price snapshotted from the live catalog at add-time (variant price when a variant)
//   • add-on options resolved + priced server-side (never trust client prices)

import { randomBytes } from "node:crypto";
import type { ApiError, CartWithItemsDTO, CartItemDTO } from "@sam-store/contracts";
import type {
  CartRecord,
  CartRepository,
  CatalogRepository,
  ProductRecord,
  ProductVariantRecord,
  AddonRecord,
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

/** P2a: client-selected add-on option references; prices/details are resolved server-side. */
export interface AddOnSelection {
  addonId: string;
  optionId: string;
}

export interface AddLineOptions {
  variantId?: string;
  addons?: AddOnSelection[];
}

function addonFingerprint(addons: { optionId: string }[]): string {
  return addons.map((a) => a.optionId).sort().join("+");
}

export class CartService {
  constructor(
    private readonly carts: CartRepository,
    private readonly catalog: CatalogRepository,
  ) {}

  private toDTO(cart: CartRecord, products: Map<string, ProductRecord>, variants: Map<string, ProductVariantRecord>): CartWithItemsDTO {
    const items: CartItemDTO[] = cart.lines.map((l) => {
      const p = products.get(l.productId);
      const v = l.variantId ? variants.get(l.variantId) : undefined;
      const addonsTotalMinor = l.addonsTotalMinor ?? 0;
      return {
        lineId: l.lineId ?? "",
        productId: l.productId,
        sku: v?.sku ?? p?.sku ?? "UNKNOWN",
        name: p?.name ?? "Unknown product",
        variantId: l.variantId ?? null,
        variant: v ? { id: v.id, name: v.name, sku: v.sku } : null,
        addons: (l.addons as CartItemDTO["addons"]) ?? [],
        addonsTotalMinor,
        unitPriceMinor: l.unitPriceMinor,
        quantity: l.quantity,
        lineTotalMinor: (l.unitPriceMinor + addonsTotalMinor) * l.quantity,
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
    const [products, variants] = await Promise.all([this.loadProducts(cart), this.loadVariants(cart)]);
    return { ok: true, value: this.toDTO(cart, products, variants) };
  }

  async addItem(
    token: string,
    productId: string,
    quantity: number,
    opts: AddLineOptions = {},
  ): Promise<CartResult<CartWithItemsDTO>> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { ok: false, error: { type: "validation", errors: ["quantity must be a positive integer"] } };
    }
    if (quantity > 99) {
      return { ok: false, error: { type: "validation", errors: ["quantity cannot exceed 99"] } };
    }
    if (opts.variantId && (typeof opts.variantId !== "string" || opts.variantId.length > 200)) {
      return { ok: false, error: { type: "validation", errors: ["variantId is invalid"] } };
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

    // P2a: variant resolution — must belong to this product, active, own price + stock.
    let variant: ProductVariantRecord | null = null;
    if (opts.variantId) {
      variant = await this.catalog.getVariantById(opts.variantId);
      if (!variant || variant.productId !== product.id) {
        return { ok: false, error: { type: "validation", errors: ["Variant does not belong to this product"] } };
      }
      if (!variant.isActive) {
        return { ok: false, error: { type: "conflict", message: "Variant is not available" } };
      }
    }

    // P2a: add-on resolution — options must belong to the product, be active; price server-side.
    const addons = opts.addons ?? [];
    const addonSnapshot: unknown[] = [];
    let addonsTotalMinor = 0;
    if (addons.length > 0) {
      const groups = await this.catalog.getProductAddons(product.storeId, product.id);
      const optionById = new Map<string, { addonId: string; name: string; priceMinor: number }>();
      for (const g of groups) {
        for (const o of g.options) optionById.set(o.id, { addonId: g.id, name: o.name, priceMinor: o.priceMinor });
      }
      const seen = new Set<string>();
      for (const sel of addons) {
        if (!sel?.addonId || !sel?.optionId) {
          return { ok: false, error: { type: "validation", errors: ["addons entries need addonId and optionId"] } };
        }
        if (seen.has(sel.optionId)) continue; // dedupe repeated option picks
        seen.add(sel.optionId);
        const option = optionById.get(sel.optionId);
        if (!option || option.addonId !== sel.addonId) {
          return { ok: false, error: { type: "validation", errors: ["Add-on option does not belong to this product"] } };
        }
        addonSnapshot.push({ addonId: sel.addonId, optionId: sel.optionId, name: option.name, priceMinor: option.priceMinor });
        addonsTotalMinor += option.priceMinor;
      }
    }
    const addonKey = addonSnapshot.length > 0 ? addonFingerprint(addonSnapshot as { optionId: string }[]) : null;

    // Stock check: available = onHand - reserved - already-in-cart qty (same line identity).
    const available = variant
      ? variant.quantityOnHand - variant.quantityReserved
      : product.quantityOnHand - product.quantityReserved;
    const existingQty = cart.lines.find(
      (l) => l.productId === productId && (l.variantId ?? null) === (variant?.id ?? null) && (l.addonKey ?? null) === addonKey,
    )?.quantity ?? 0;
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

    await this.carts.addItem(cart.id, cart.storeId, productId, quantity, variant?.priceMinor ?? product.priceMinor, {
      variantId: variant?.id ?? null,
      addonKey,
      addons: addonSnapshot,
      addonsTotalMinor,
    });
    const fresh = (await this.carts.findByToken(token))!;
    const [products, variantsMap] = await Promise.all([this.loadProducts(fresh), this.loadVariants(fresh)]);
    return { ok: true, value: this.toDTO(fresh, products, variantsMap) };
  }

  async updateQuantity(token: string, lineId: string, quantity: number): Promise<CartResult<CartWithItemsDTO>> {
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
    const line = cart.lines.find((l) => l.lineId === lineId);
    if (!line) return { ok: false, error: { type: "not_found", message: "Item not in cart" } };

    if (line.variantId) {
      const variant = await this.catalog.getVariantById(line.variantId);
      if (variant) {
        const available = variant.quantityOnHand - variant.quantityReserved;
        if (quantity > available) {
          return { ok: false, error: { type: "conflict", message: `Only ${available} in stock` } };
        }
      }
    } else {
      const product = (await this.catalog.getProductsByIds(cart.storeId, [line.productId]))[0] ?? null;
      if (product) {
        const available = product.quantityOnHand - product.quantityReserved;
        if (quantity > available) {
          return { ok: false, error: { type: "conflict", message: `Only ${available} in stock` } };
        }
      }
    }

    await this.carts.updateItemQuantity(lineId, quantity);
    const fresh = (await this.carts.findByToken(token))!;
    const [products, variants] = await Promise.all([this.loadProducts(fresh), this.loadVariants(fresh)]);
    return { ok: true, value: this.toDTO(fresh, products, variants) };
  }

  async removeItem(token: string, lineId: string): Promise<CartResult<CartWithItemsDTO>> {
    const cart = await this.carts.findByToken(token);
    if (!cart) return { ok: false, error: { type: "not_found", message: "Cart not found" } };
    await this.carts.removeItem(lineId);
    const fresh = (await this.carts.findByToken(token))!;
    const [products, variants] = await Promise.all([this.loadProducts(fresh), this.loadVariants(fresh)]);
    return { ok: true, value: this.toDTO(fresh, products, variants) };
  }

  private async loadProducts(cart: CartRecord): Promise<Map<string, ProductRecord>> {
    if (cart.storeId === "" || cart.lines.length === 0) return new Map();
    const products = await this.catalog.getProductsByIds(
      cart.storeId,
      cart.lines.map((l) => l.productId),
    );
    return new Map(products.map((p) => [p.id, p]));
  }

  private async loadVariants(cart: CartRecord): Promise<Map<string, ProductVariantRecord>> {
    const ids = cart.lines.map((l) => l.variantId).filter((v): v is string => !!v);
    if (ids.length === 0 || cart.storeId === "") return new Map();
    const variants = await this.catalog.getVariantsByIds(cart.storeId, ids);
    return new Map(variants.map((v) => [v.id, v]));
  }
}