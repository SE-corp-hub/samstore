// The hub door: SE Corp Hub takes an order on a Facebook Page (chat, order form, comment, Live) and hands it
// here, so it lands in this store's Orders like any other. Framework-free, like CheckoutService, which does the
// real work: the door only finds the store and its items, builds the cart, and says where the order came from.
// Prices are this store's own; the hub may pass a discount and a delivery fee it already agreed with the customer.

import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiError, CheckoutResponse } from "@sam-store/contracts";
import type { CheckoutService } from "../checkout/checkout.service.js";
import type { CartRepository, CatalogRepository, StoreRepository } from "../persistence/repositories.js";
import { randomId } from "../persistence/repositories.js";
import { checkDto, HUB_ORDER_DTO } from "../security/validate.js";

export const HUB_CHANNELS = ["messenger", "order_form", "comment", "live", "agent", "counter"] as const;

export interface HubOrderRequest {
  storeSlug: string;
  /** The hub's own key for this order: the same key again returns the same order. */
  idempotencyKey: string;
  /** The hub's order reference, shown to staff, e.g. "#1001". */
  externalRef?: string;
  channel: (typeof HUB_CHANNELS)[number];
  /** The selling page's name, e.g. "Samrice". */
  pageName: string;
  customerName: string;
  customerPhone: string;
  deliveryType?: "delivery" | "pickup";
  address?: string;
  landmark?: string;
  notes?: string;
  /** Each item by SKU, or by its exact name (case does not matter). */
  items: { sku?: string; name?: string; quantity: number }[];
  discountMinor?: number;
  deliveryFeeMinor?: number;
}

/** Where a hub order stands in Sam Store now: the hub follows it, since orders are changed here, not there. */
export interface HubOrderUpdate {
  orderNumber: string;
  status: string;
  deliveryType: string;
  totalMinor: number;
  deliveryFeeMinor: number;
  discountMinor: number;
  items: { name: string; quantity: number; unitPriceMinor: number }[];
}
/** The store's hub orders placed or changed since a time, newest changes included. */
export type RecentHubOrders = (storeId: string, since: Date) => Promise<HubOrderUpdate[]>;

export type HubOrderResult = { ok: true; value: CheckoutResponse } | { ok: false; error: ApiError };

/** True only for the configured secret, compared in constant time. An unset or short secret keeps the door shut. */
export function hubSecretOk(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected || expected.length < 32) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export const HUB_ORDER_SERVICE = Symbol("HUB_ORDER_SERVICE");

export class HubOrderService {
  constructor(
    private readonly stores: StoreRepository,
    private readonly catalog: CatalogRepository,
    private readonly carts: CartRepository,
    private readonly checkout: CheckoutService,
    private readonly recent: RecentHubOrders = async () => [],
  ) {}

  /** The store's hub orders from the last few days as they are now, for the hub to follow. */
  async updates(storeSlug: string, now = Date.now()): Promise<HubOrderUpdate[]> {
    const store = await this.stores.findBySlug(storeSlug);
    return store ? this.recent(store.id, new Date(now - 3 * 86_400_000)) : [];
  }

  /** The store's active items with what can still be sold, for the hub to copy: Sam Store owns names and prices. */
  async products(storeSlug: string): Promise<{ sku: string; name: string; category: string | null; priceMinor: number; available: number }[] | null> {
    const store = await this.stores.findBySlug(storeSlug);
    if (!store) return null;
    return (await this.catalog.listActiveProducts(store.id)).map((p) => ({
      sku: p.sku,
      name: p.name,
      category: p.categoryName,
      priceMinor: p.priceMinor,
      available: Math.max(0, p.quantityOnHand - p.quantityReserved),
    }));
  }

  async place(req: HubOrderRequest): Promise<HubOrderResult> {
    const store = await this.stores.findBySlug(req.storeSlug);
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };

    // Only this store's active items can match, so another store's SKU is simply unknown here.
    const products = await this.catalog.listActiveProducts(store.id);
    const lines: { productId: string; quantity: number; unitPriceMinor: number }[] = [];
    const unknown: string[] = [];
    for (const item of req.items) {
      const p = products.find(
        (x) => (item.sku && norm(x.sku) === norm(item.sku)) || (item.name && norm(x.name) === norm(item.name)),
      );
      if (!p) unknown.push(item.name ?? item.sku ?? "?");
      else {
        const same = lines.find((l) => l.productId === p.id);
        if (same) same.quantity += item.quantity;
        else lines.push({ productId: p.id, quantity: item.quantity, unitPriceMinor: p.priceMinor });
      }
    }
    if (unknown.length > 0) {
      return {
        ok: false,
        error: { type: "validation", errors: unknown.map((n) => `"${n}" is not an active item in this store`) },
      };
    }

    // The cart's token comes from the key, so a retry finds the same cart and checkout returns the same order.
    const cartToken = `hub-${createHash("sha256").update(`${store.id}:${req.idempotencyKey}`).digest("hex")}`;
    // Lines are added one by one (that is how the database cart saves them), and only the ones not there yet,
    // so a retry after a half-built cart finishes it instead of doubling it.
    const cart =
      (await this.carts.findByToken(cartToken)) ??
      (await this.carts.create({ id: randomId(), storeId: store.id, token: cartToken, status: "OPEN", lines: [] }));
    if (cart.status === "OPEN") {
      for (const l of lines) {
        if (!cart.lines.some((x) => x.productId === l.productId)) {
          await this.carts.addItem(cart.id, store.id, l.productId, l.quantity, l.unitPriceMinor);
        }
      }
    }

    const pickup = req.deliveryType === "pickup";
    return this.checkout.checkout(
      {
        cartToken,
        idempotencyKey: `hub:${store.id}:${req.idempotencyKey}`.slice(0, 128),
        customerName: req.customerName,
        customerPhone: req.customerPhone,
        // The customer gave these details to the hub's Page to place this very order.
        consentGranted: true,
        deliveryType: pickup ? "pickup" : "delivery",
        ...(req.address ? { deliveryAddressLine1: req.address } : {}),
        ...(req.landmark ? { landmark: req.landmark } : {}),
        ...(req.notes ? { notes: req.notes } : {}),
      },
      {
        source: "hub",
        sourceChannel: req.channel,
        sourcePage: req.pageName,
        externalRef: req.externalRef ?? null,
        ...(req.discountMinor ? { discountMinor: req.discountMinor } : {}),
        ...(req.deliveryFeeMinor !== undefined ? { deliveryFeeMinor: req.deliveryFeeMinor } : {}),
      },
    );
  }
}

/**
 * Sam Store calls the hub, never the other way: Render's guard (Cloudflare) answers the hub's calls with 429, and
 * calls out of Render are not blocked. Each beat fetches the hub's waiting orders, places them (the same key gives
 * the same order back, so a lost answer is safe), says what became of each, and sends the linked stores' items and
 * how their hub orders stand now (step, items, total), so an order changed here shows changed in the hub too.
 */
export async function syncWithHub(
  hub: HubOrderService,
  hubUrl: string,
  secret: string,
  send = fetch,
  /** full: false = a quick beat — only ask for waiting orders, and answer the hub only when some came. */
  opts: { full?: boolean } = {},
): Promise<void> {
  const door = `${hubUrl.replace(/\/+$/, "")}/api/samstore`;
  const headers = { "x-hub-secret": secret, "content-type": "application/json" };
  const res = await send(door, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`hub answered ${res.status}`);
  const got = (await res.json()) as { stores?: unknown; orders?: unknown };
  // Quick beat with nothing waiting: no answer, so the hub's copy of items and orders is not rewritten every 15 s.
  if (opts.full === false && !(Array.isArray(got.orders) && got.orders.length > 0)) return;
  const results: { key: string; orderNumber?: string; totalMinor?: number; error?: string }[] = [];
  for (const o of Array.isArray(got.orders) ? got.orders.slice(0, 50) : []) {
    const key = String((o as { idempotencyKey?: unknown })?.idempotencyKey ?? "").slice(0, 60);
    const dto = checkDto<HubOrderRequest>(o, HUB_ORDER_DTO);
    if (!dto.ok) {
      results.push({ key, error: dto.errors.join("; ") });
      continue;
    }
    try {
      const r = await hub.place(dto.value);
      results.push(
        r.ok
          ? { key, orderNumber: r.value.orderNumber, totalMinor: r.value.totalMinor }
          : { key, error: "errors" in r.error ? r.error.errors.join("; ") : r.error.message },
      );
    } catch (e) {
      results.push({ key, error: e instanceof Error ? e.message : "Sam Store couldn't place it" });
    }
  }
  const products = [];
  const updates = [];
  for (const store of Array.isArray(got.stores) ? got.stores.filter((s): s is string => typeof s === "string").slice(0, 20) : []) {
    products.push({ store, products: (await hub.products(store)) ?? [] });
    updates.push(...(await hub.updates(store)).map((u) => ({ store, ...u })));
  }
  await send(door, {
    method: "POST",
    headers,
    body: JSON.stringify({ results, products, updates: updates.slice(0, 200) }),
    signal: AbortSignal.timeout(20_000),
  });
}
