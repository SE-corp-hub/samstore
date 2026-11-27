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
import type { ChangedBuys, HubBuys } from "./hub-buys.js";
import type { HubTap, HubTapApplier } from "./hub-taps.js";
import { readTruckMove, type HubTruckApplier, type HubTruckMove } from "./hub-truck.js";

/** What this Sam Store understands of the hub link; sent on every call (see syncWithHub). */
export const HUB_LINK_VERSION = 3;

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
  /** unitPriceMinor: the price each the customer was told on the Page; the order is placed at that price. */
  items: { sku?: string; name?: string; quantity: number; unitPriceMinor?: number }[];
  discountMinor?: number;
  deliveryFeeMinor?: number;
  /** The Sam Store location that sells for this Page (its code, e.g. "S2"): stock is held there first. */
  locationCode?: string;
  /** How the customer said they will pay on the Page. GCash is shown to staff on the order. */
  paymentMethod?: "cod" | "gcash";
  /** This store's own id for the customer (StoreCustomer.id), when the hub knows it: the order goes under them. */
  customerRef?: string;
  /** Why the hub changed a price on this order before it came here, and who did: kept on each changed line. */
  priceReason?: string;
  priceBy?: string;
}

/** What the door does after an order is placed: put it under its customer, and mark the lines sold at another price. */
export interface PlacedInfo {
  customerRef?: string;
  customerName: string;
  customerPhone: string;
  address?: string;
  /** Lines the Page sold at another price than this store's price at that moment. */
  repriced: { productId: string; catalogUnitPriceMinor: number }[];
  priceReason?: string;
  priceBy?: string;
}

/** A price change on one of this store's hub orders, asked for in the hub by the owner or a manager. */
export interface HubPriceChange {
  orderNumber: string;
  items: { sku?: string; name?: string; unitPriceMinor: number }[];
  reason: string;
  by: string;
  /** Who asked, as the hub knows them: "owner", or "manager" (a Business lead there). Both change prices as a manager does here. */
  role: string;
}

/** One selling day of the store, or of one of its locations (`location` = its code), for the hub's owner. */
export interface HubDay {
  day: string;
  location: string;
  /** Sales less what was taken back. */
  salesMinor: number;
  costMinor: number;
  expensesMinor: number;
  profitMinor: number;
  orders: number;
  /** Units sold with no cost on record (counted at 0, so the profit reads too high). */
  noCostUnits: number;
  /** The part of the sales that came through the hub, so the two sides can be compared. */
  hubSalesMinor: number;
  hubOrders: number;
}

/** The parts of the hub link that need this store's database; each has a harmless default for tests. */
export interface HubExtras {
  /** The ids of the store's per-kilo items: the hub sells whole sacks and packs only. */
  kiloIds: (storeId: string) => Promise<Set<string>>;
  afterPlace: (storeId: string, orderNumber: string, info: PlacedInfo) => Promise<void>;
  /** Null when the price is changed (or already was), else why not, in words staff read in the hub. */
  change: (storeId: string, change: HubPriceChange) => Promise<string | null>;
  /** The last `count` Manila days, today first: the whole store (location "") and each of its locations. */
  days: (storeId: string, count: number, now: Date) => Promise<HubDay[]>;
  /** What each customer bought here (not through the hub), for the hub's customer cards (integrations/hub-buys.ts). */
  buys: ChangedBuys;
}
const NO_EXTRAS: HubExtras = {
  kiloIds: async () => new Set(),
  afterPlace: async () => {},
  change: async () => "This Sam Store cannot take price changes from the hub yet",
  days: async () => [],
  buys: async () => [],
};

/** Where a hub order stands in Sam Store now: the hub follows it, since orders are changed here, not there. */
export interface HubOrderUpdate {
  orderNumber: string;
  status: string;
  deliveryType: string;
  totalMinor: number;
  deliveryFeeMinor: number;
  discountMinor: number;
  /** PENDING | COLLECTED | … : whether the money is in, so the hub can show "Paid". */
  paymentStatus?: string;
  /** What the order's items cost this store (frozen with the sale once handed over, else today's cost). Null when
   *  an item has no cost on record. The hub shows profit to the owner only. */
  costMinor?: number | null;
  /** Why it was cancelled or the delivery failed, as staff typed it. */
  reason?: string | null;
  items: { name: string; sku?: string; quantity: number; unitPriceMinor: number }[];
}
/** One of the store's customers as the hub keeps it: details, utang and points, and when any of it last changed. */
export interface HubCustomer {
  id: string;
  changedAt: string;
  name: string;
  phone: string;
  address: string;
  /** What the customer owes on utang now (0 when nothing). */
  utangMinor: number;
  points: number;
  /** The code of the location the customer was added at (S1, S3 …), or "" when not known: the hub files a new
   * customer under the business that sells from that location. */
  location: string;
}
/** The store's customers changed after a point (time, then id), oldest change first, at most `limit`. */
export type ChangedCustomers = (storeId: string, after: { at: string; id: string }, limit: number) => Promise<HubCustomer[]>;

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

const peso = (minor: number) => `₱${(minor / 100).toLocaleString("en-PH", { minimumFractionDigits: minor % 100 ? 2 : 0 })}`;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export const HUB_ORDER_SERVICE = Symbol("HUB_ORDER_SERVICE");

export class HubOrderService {
  constructor(
    private readonly stores: StoreRepository,
    private readonly catalog: CatalogRepository,
    private readonly carts: CartRepository,
    private readonly checkout: CheckoutService,
    private readonly recent: RecentHubOrders = async () => [],
    /** A location's id from its code (S1, S2 …) in this store, or null. */
    private readonly locate: (storeId: string, code: string) => Promise<string | null> = async () => null,
    /** A location's own selling prices by product id (products without one sell at the store's price). */
    private readonly pricesAt: (storeId: string, locationId: string) => Promise<Map<string, number>> = async () => new Map(),
    /**
     * What a store can still sell of each product: the free stock on its own shelf and on the places it may take
     * rice from (null location = the main store). Null when the store has no take-rice-from rule yet.
     */
    private readonly freeFor: (storeId: string, locationId: string | null) => Promise<Map<string, number> | null> = async () => null,
    /** The store's customers that changed after a point, for the hub's Customers list: this store owns their details. */
    private readonly changedCustomers: ChangedCustomers = async () => [],
    /** Moves one of the store's hub orders on a delivery tap from the hub (integrations/hub-taps.ts). */
    private readonly applyTap: HubTapApplier = async () => "This Sam Store cannot take delivery taps yet",
    /** Moves a truck's sacks in this store's stock when the hub says so (integrations/hub-truck.ts). */
    private readonly applyTruck: HubTruckApplier = async () => "This Sam Store cannot move truck stock yet",
    extras: Partial<HubExtras> = {},
  ) {
    this.extras = { ...NO_EXTRAS, ...extras };
  }
  private readonly extras: HubExtras;

  /** A price change the hub asks for on one of this store's hub orders. */
  async change(storeSlug: string, change: HubPriceChange): Promise<string | null> {
    const store = await this.stores.findBySlug(storeSlug);
    return store ? this.extras.change(store.id, change) : "Store not found";
  }

  /** The store's last selling days (sales, cost, expenses, profit), for the hub's owner. */
  async days(storeSlug: string, count: number, now = new Date()): Promise<HubDay[]> {
    const store = await this.stores.findBySlug(storeSlug);
    return store ? this.extras.days(store.id, Math.min(35, Math.max(1, count)), now) : [];
  }

  /**
   * A truck move from the hub (a confirmed load, or a closed day): null when the stock is moved, or was already,
   * else why not, in words staff read on the truck's sheet in the hub.
   */
  async truck(storeSlug: string, move: HubTruckMove): Promise<string | null> {
    const store = await this.stores.findBySlug(storeSlug);
    return store ? this.applyTruck(store.id, move) : "Store not found";
  }

  /**
   * A tap from the hub's Deliveries page (On the way, Delivered) on one of this store's hub orders: null when the
   * order is there now, else why not, in words the delivery person reads in the hub.
   */
  async tap(storeSlug: string, tap: HubTap): Promise<string | null> {
    const store = await this.stores.findBySlug(storeSlug);
    return store ? this.applyTap(store.id, tap) : "Store not found";
  }

  /** Up to 200 customers whose own orders here changed after the hub's last copy, oldest change first. */
  async buys(storeSlug: string, after: { at: string; id: string }): Promise<HubBuys[]> {
    const store = await this.stores.findBySlug(storeSlug);
    return store ? this.extras.buys(store.id, after, 200) : [];
  }

  /** Up to 200 of the store's customers changed after the hub's last copy, oldest change first. */
  async customers(storeSlug: string, after: { at: string; id: string }): Promise<HubCustomer[]> {
    const store = await this.stores.findBySlug(storeSlug);
    return store ? this.changedCustomers(store.id, after, 200) : [];
  }

  /** The store's hub orders from the last few days as they are now, for the hub to follow. */
  async updates(storeSlug: string, now = Date.now()): Promise<HubOrderUpdate[]> {
    const store = await this.stores.findBySlug(storeSlug);
    return store ? this.recent(store.id, new Date(now - 3 * 86_400_000)) : [];
  }

  /** The store's active items with what can still be sold, for the hub to copy: Sam Store owns names and prices. */
  async products(storeSlug: string, locationCode?: string): Promise<{ sku: string; name: string; category: string | null; priceMinor: number; available: number }[] | null> {
    const store = await this.stores.findBySlug(storeSlug);
    if (!store) return null;
    // The selling price is the linked location's own price where it has one (Menu > Prices), else the store's.
    const loc = locationCode ? await this.locate(store.id, locationCode) : null;
    const own = loc ? await this.pricesAt(store.id, loc) : new Map<string, number>();
    // The Page may only promise rice its store can take: its own shelf and the places on its list.
    const free = await this.freeFor(store.id, loc);
    // Per-kilo rice is weighed at the counter: the Page sells whole sacks and packs only, so it is not offered there.
    const kilo = await this.extras.kiloIds(store.id);
    return (await this.catalog.listActiveProducts(store.id)).filter((p) => !kilo.has(p.id)).map((p) => ({
      sku: p.sku,
      name: p.name,
      category: p.categoryName,
      priceMinor: own.get(p.id) ?? p.priceMinor,
      available: free ? free.get(p.id) ?? 0 : Math.max(0, p.quantityOnHand - p.quantityReserved),
    }));
  }

  async place(req: HubOrderRequest): Promise<HubOrderResult> {
    const store = await this.stores.findBySlug(req.storeSlug);
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };

    // Only this store's active items can match, so another store's SKU is simply unknown here.
    const products = await this.catalog.listActiveProducts(store.id);
    const sellingLocationId = req.locationCode ? await this.locate(store.id, req.locationCode) : null;
    const own = sellingLocationId ? await this.pricesAt(store.id, sellingLocationId) : new Map<string, number>();
    const lines: { productId: string; quantity: number; unitPriceMinor: number }[] = [];
    const unknown: string[] = [];
    // Where the Page told the customer another price than the store's price now (a price changed in between, or
    // a wholesale price): the order keeps the customer's price, and staff see both on the order.
    const told: string[] = [];
    const repriced: PlacedInfo["repriced"] = [];
    const kilo = await this.extras.kiloIds(store.id);
    const perKilo: string[] = [];
    for (const item of req.items) {
      // The item's code first: a name can be changed here, a code is not.
      const p =
        (item.sku ? products.find((x) => norm(x.sku) === norm(item.sku!)) : undefined) ??
        (item.name ? products.find((x) => norm(x.name) === norm(item.name!)) : undefined);
      if (!p) unknown.push(item.name ?? item.sku ?? "?");
      else if (kilo.has(p.id)) perKilo.push(p.name);
      else {
        const ours = own.get(p.id) ?? p.priceMinor;
        const price = item.unitPriceMinor && item.unitPriceMinor > 0 ? item.unitPriceMinor : ours;
        const same = lines.find((l) => l.productId === p.id);
        if (same) same.quantity += item.quantity;
        else {
          lines.push({ productId: p.id, quantity: item.quantity, unitPriceMinor: price });
          if (price !== ours) {
            told.push(`${p.name}: Page price ${peso(price)}, store price now ${peso(ours)}.`);
            repriced.push({ productId: p.id, catalogUnitPriceMinor: ours });
          }
        }
      }
    }
    if (unknown.length > 0 || perKilo.length > 0) {
      return {
        ok: false,
        error: {
          type: "validation",
          errors: [
            ...unknown.map((n) => `"${n}" is not an active item in this store`),
            // A per-kilo line counts grams here, and the Page counts pieces: taking it would hold 2 grams for "2".
            ...perKilo.map((n) => `"${n}" is sold per kilo, which the Page cannot order. Take this order at the counter in Sam Store`),
          ],
        },
      };
    }

    // The cart's token comes from the key, so a retry finds the same cart and checkout returns the same order.
    const cartToken = `hub-${createHash("sha256").update(`${store.id}:${req.idempotencyKey}`).digest("hex")}`;
    const cart =
      (await this.carts.findByToken(cartToken)) ??
      (await this.carts.create({ id: randomId(), storeId: store.id, token: cartToken, status: "OPEN", lines: [] }));
    // Stock is checked before checkout, which takes an order number first: a refusal here costs no number, so an
    // order the hub offers again every few seconds can't eat through the order numbers while it waits for stock.
    // Skipped once placed (the cart became the order): checkout hands back that same order, whose own hold counts.
    const short: string[] = [];
    const reach = cart.status === "OPEN" ? await this.freeFor(store.id, sellingLocationId) : null;
    for (const l of cart.status === "OPEN" ? lines : []) {
      const p = products.find((x) => x.id === l.productId)!;
      const free = reach ? reach.get(p.id) ?? 0 : p.quantityOnHand - p.quantityReserved;
      if (free < l.quantity) short.push(`Not enough "${p.name}": needs ${l.quantity}, ${Math.max(0, free)} left ${reach ? "where this store may take rice from" : "in all locations"}`);
    }
    if (cart.status === "OPEN" && short.length > 0) return { ok: false, error: { type: "validation", errors: short } };

    if (cart.status === "OPEN") {
      // The cart follows the order as the hub has it NOW: an earlier try that was refused (no stock) may have left
      // other quantities or items behind, and the customer may have changed the order in the hub since.
      for (const x of cart.lines) {
        const want = lines.find((l) => l.productId === x.productId && !x.variantId);
        if (!x.lineId) continue;
        if (!want) await this.carts.removeItem(x.lineId);
        else if (want.quantity !== x.quantity) await this.carts.updateItemQuantity(x.lineId, want.quantity);
      }
      for (const l of lines) {
        if (!cart.lines.some((x) => x.productId === l.productId && !x.variantId)) {
          await this.carts.addItem(cart.id, store.id, l.productId, l.quantity, l.unitPriceMinor);
        }
      }
    }

    const notes = [req.notes ?? "", ...told]
      .filter(Boolean)
      .join(" ")
      .slice(0, 500);
    const pickup = req.deliveryType === "pickup";
    const placed = await this.checkout.checkout(
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
        ...(notes ? { notes } : {}),
      },
      {
        source: "hub",
        sourceChannel: req.channel,
        sourcePage: req.pageName,
        externalRef: req.externalRef ?? null,
        ...(req.discountMinor ? { discountMinor: req.discountMinor } : {}),
        ...(req.deliveryFeeMinor !== undefined ? { deliveryFeeMinor: req.deliveryFeeMinor } : {}),
        ...(sellingLocationId ? { sellingLocationId } : {}),
        unitPrices: Object.fromEntries(lines.map((l) => [l.productId, l.unitPriceMinor])),
        ...(req.paymentMethod === "gcash" ? { gcash: true } : {}),
      },
    );
    // The order is in. It is then put under its customer and its changed prices are marked. If that misses (the
    // database blinked), the hub is told to offer the order again: checkout hands back this same order, and the
    // step is tried again, so no hub order is left without its customer.
    if (placed.ok) {
      try {
        await this.extras.afterPlace(store.id, placed.value.orderNumber, {
          ...(req.customerRef ? { customerRef: req.customerRef } : {}),
          customerName: req.customerName,
          customerPhone: req.customerPhone,
          ...(req.address ? { address: req.address } : {}),
          repriced,
          ...(req.priceReason ? { priceReason: req.priceReason } : {}),
          ...(req.priceBy ? { priceBy: req.priceBy } : {}),
        });
      } catch (e) {
        console.warn(`[sam-store] hub order ${placed.value.orderNumber}: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false, error: { type: "validation", errors: [`Sam Store took this order as ${placed.value.orderNumber} but could not finish saving it. It tries again by itself in a few seconds`] } };
      }
    }
    return placed;
  }
}

/** One Facebook order the hub offered that this store could not take, and why: staff see these in Orders. */
export interface StuckHubOrder {
  store: string;
  key: string;
  ref: string;
  page: string;
  customer: string;
  items: string;
  error: string;
  since: string;
}

/**
 * How the hub link stands, for the Orders screen: kept in memory, since every beat rebuilds it from the hub's own
 * list (a restart just waits for the next beat, a few seconds).
 */
export interface HubLinkState {
  on: boolean;
  lastTryAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  stuck: StuckHubOrder[];
}
const link: HubLinkState = { on: false, lastTryAt: null, lastOkAt: null, lastError: null, stuck: [] };

/** The link's state as one store sees it (only its own stuck orders). */
export function hubLinkStatus(storeSlug: string): HubLinkState {
  return { ...link, stuck: link.stuck.filter((o) => o.store === storeSlug) };
}

/** Plain words for why the hub couldn't be reached, for the owner. */
function linkError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/401/.test(m)) return "The hub refused the secret. HUB_ORDER_SECRET in Render must match SAMSTORE_ORDER_SECRET in the hub.";
  if (/404/.test(m)) return "The hub's link is off. Set SAMSTORE_ORDER_SECRET and SAMSTORE_STORES in the hub.";
  if (/timeout|abort/i.test(m)) return "The hub took too long to answer. It tries again in a few seconds.";
  return `Couldn't reach the hub (${m.slice(0, 120)}). It tries again in a few seconds.`;
}

/**
 * Sam Store calls the hub, never the other way: Render's guard (Cloudflare) answers the hub's calls with 429, and
 * calls out of Render are not blocked. Each beat fetches the hub's waiting orders, places them (the same key gives
 * the same order back, so a lost answer is safe), says what became of each, and sends the linked stores' items and
 * how their hub orders stand now (step, items, total, paid), so an order changed here shows changed in the hub too.
 * The hub's delivery team taps On the way and Delivered in the hub: those taps come with the waiting orders, move
 * the order here, and the hub then follows it like any other change. A tap we can't act on goes back with why.
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
  // x-samstore-link: what this Sam Store understands, so a newer hub never sends an older Sam Store a field it
  // would refuse (the order check turns away keys it does not know). 2 = customer reference, price reason,
  // price changes from the hub, selling days.
  const headers = { "x-hub-secret": secret, "content-type": "application/json", "x-samstore-link": String(HUB_LINK_VERSION) };
  link.lastTryAt = new Date().toISOString();
  try {
    const res = await send(door, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`hub answered ${res.status}`);
    const got = (await res.json()) as { stores?: unknown; orders?: unknown; taps?: unknown; truck?: unknown };
    const offered = Array.isArray(got.orders) ? got.orders.slice(0, 50) : [];
    // Delivery taps the hub is holding for orders that live here (see hub-taps.ts).
    const tapped = Array.isArray(got.taps) ? got.taps.slice(0, 50) : [];
    // Truck moves the hub is holding for this store's stock (see hub-truck.ts).
    const trucks = Array.isArray(got.truck) ? got.truck.slice(0, 20) : [];
    // Price changes the owner or a manager asked for in the hub, on orders that live here.
    const asked = Array.isArray((got as { changes?: unknown }).changes) ? (got as { changes: unknown[] }).changes.slice(0, 50) : [];
    // Quick beat with nothing waiting: no answer, so the hub's copy of items and orders is not rewritten every 15 s.
    if (opts.full === false && offered.length === 0 && tapped.length === 0 && trucks.length === 0 && asked.length === 0) {
      link.stuck = [];
      link.lastOkAt = new Date().toISOString();
      link.lastError = null;
      return;
    }
    const results: { key: string; orderNumber?: string; totalMinor?: number; error?: string }[] = [];
    const stuck: StuckHubOrder[] = [];
    for (const o of offered) {
      const raw = (o ?? {}) as Record<string, unknown>;
      const key = String(raw.idempotencyKey ?? "").slice(0, 60);
      const fail = (error: string) => {
        results.push({ key, error });
        const items = Array.isArray(raw.items) ? raw.items : [];
        stuck.push({
          store: String(raw.storeSlug ?? ""),
          key,
          ref: String(raw.externalRef ?? key).slice(0, 64),
          page: String(raw.pageName ?? "").slice(0, 120),
          customer: String(raw.customerName ?? "").slice(0, 120),
          items: items
            .map((i: Record<string, unknown>) => `${Number(i?.quantity) || 0} × ${String(i?.name ?? i?.sku ?? "?")}`)
            .join(", ")
            .slice(0, 300),
          error,
          since: link.stuck.find((x) => x.key === key)?.since ?? new Date().toISOString(),
        });
      };
      const dto = checkDto<HubOrderRequest>(o, HUB_ORDER_DTO);
      if (!dto.ok) {
        fail(dto.errors.join("; "));
        continue;
      }
      try {
        const r = await hub.place(dto.value);
        if (r.ok) results.push({ key, orderNumber: r.value.orderNumber, totalMinor: r.value.totalMinor });
        else fail("errors" in r.error ? r.error.errors.join("; ") : r.error.message);
      } catch (e) {
        fail(e instanceof Error ? e.message : "Sam Store couldn't place it");
      }
    }
    link.stuck = stuck;
    // Taps come before `updates` is built, so the same answer tells the hub where each order stands now. A tap we
    // can't act on goes back with the reason; one that crashed is left alone, and the hub offers it again.
    const refusedTaps: { id: number; error: string }[] = [];
    for (const t of tapped) {
      const raw = (t ?? {}) as Record<string, unknown>;
      const id = raw.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;
      const status = raw.status;
      if (typeof raw.store !== "string" || typeof raw.orderNumber !== "string" || !raw.orderNumber || (status !== "CONFIRMED" && status !== "OUT_FOR_DELIVERY" && status !== "DELIVERED")) {
        refusedTaps.push({ id, error: "Sam Store could not read this tap" });
        continue;
      }
      const cash = raw.cashMinor;
      try {
        const error = await hub.tap(raw.store.slice(0, 120), {
          orderNumber: raw.orderNumber.slice(0, 64),
          status,
          ...(typeof raw.at === "string" ? { at: raw.at.slice(0, 40) } : {}),
          ...(typeof raw.by === "string" && raw.by.trim() ? { by: raw.by.trim().slice(0, 60) } : {}),
          ...(typeof cash === "number" && Number.isSafeInteger(cash) && cash >= 0 ? { cashMinor: cash } : {}),
        });
        if (error) refusedTaps.push({ id, error: error.slice(0, 300) });
      } catch (e) {
        console.warn(`[sam-store] hub tap ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Price changes come before `updates` is built too: the same answer shows the hub the order at its new price.
    // Each one is answered: done, or why not. One that crashed is left alone, and the hub offers it again.
    const changeAnswers: ({ id: number; ok: true } | { id: number; error: string })[] = [];
    for (const c of asked) {
      const raw = (c ?? {}) as Record<string, unknown>;
      const id = raw.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;
      const items = (Array.isArray(raw.items) ? raw.items.slice(0, 50) : [])
        .map((i: Record<string, unknown>) => ({
          ...(typeof i?.sku === "string" && i.sku ? { sku: i.sku.slice(0, 64) } : {}),
          ...(typeof i?.name === "string" && i.name ? { name: i.name.slice(0, 200) } : {}),
          unitPriceMinor: i?.unitPriceMinor as number,
        }))
        .filter((i) => (i.sku || i.name) && Number.isSafeInteger(i.unitPriceMinor) && i.unitPriceMinor > 0 && i.unitPriceMinor <= 100_000_000);
      const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 120) : "";
      if (typeof raw.store !== "string" || typeof raw.orderNumber !== "string" || !raw.orderNumber || items.length === 0 || !reason) {
        changeAnswers.push({ id, error: "Sam Store could not read this price change" });
        continue;
      }
      try {
        const error = await hub.change(raw.store.slice(0, 120), {
          orderNumber: raw.orderNumber.slice(0, 64),
          items,
          reason,
          by: typeof raw.by === "string" && raw.by.trim() ? raw.by.trim().slice(0, 60) : "the hub",
          role: raw.role === "owner" ? "owner" : "manager",
        });
        changeAnswers.push(error ? { id, error: error.slice(0, 300) } : { id, ok: true });
      } catch (e) {
        console.warn(`[sam-store] hub price change ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Truck moves come before `products` is built, so the same answer carries the stock as the move left it. Each
    // one is answered: done, or why not. One that crashed is left alone, and the hub offers it again.
    const truckAnswers: ({ id: number; ok: true } | { id: number; error: string })[] = [];
    for (const t of trucks) {
      const id = (t as { id?: unknown } | null)?.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;
      const read = readTruckMove(t);
      if (!read) {
        truckAnswers.push({ id, error: "Sam Store could not read this truck move" });
        continue;
      }
      try {
        const error = await hub.truck(read.store, read.move);
        truckAnswers.push(error ? { id, error: error.slice(0, 300) } : { id, ok: true });
      } catch (e) {
        console.warn(`[sam-store] hub truck move ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const products = [];
    const updates = [];
    const stores = Array.isArray(got.stores) ? got.stores.filter((s): s is string => typeof s === "string").slice(0, 20) : [];
    // links: each store with the location that sells for a Page ("S2"), so its own selling prices are the ones sent.
    const links = (Array.isArray((got as { links?: unknown }).links) ? ((got as { links: unknown[] }).links as Record<string, unknown>[]) : stores.map((store): Record<string, unknown> => ({ store })))
      .map((l) => ({ store: String(l?.store ?? ""), location: typeof l?.location === "string" ? l.location.slice(0, 20) : "" }))
      .filter((l) => l.store)
      .slice(0, 40);
    for (const l of links) {
      products.push({ store: l.store, ...(l.location ? { location: l.location } : {}), products: (await hub.products(l.store, l.location || undefined)) ?? [] });
    }
    for (const store of stores) updates.push(...(await hub.updates(store)).map((u) => ({ store, ...u })));
    // Customers: only a hub that asks (it says where its copy stands) gets them, oldest change first.
    const customers = [];
    const after = Array.isArray((got as { customersAfter?: unknown }).customersAfter) ? ((got as { customersAfter: unknown[] }).customersAfter as Record<string, unknown>[]) : [];
    for (const a of after.slice(0, 20)) {
      const store = typeof a?.store === "string" ? a.store : "";
      if (!store) continue;
      const at = typeof a.at === "string" ? a.at : "";
      const id = typeof a.id === "string" ? a.id : "";
      customers.push(...(await hub.customers(store, { at, id })).map((c) => ({ store, ...c })));
    }
    // What each customer bought here: only a hub that asks (Sales CRM, 27 Nov 2026) gets it, oldest change first.
    // The customers come first in the same answer, so the hub knows each buyer before their line reaches it.
    const buys = [];
    const buysAfter = Array.isArray((got as { buysAfter?: unknown }).buysAfter) ? ((got as { buysAfter: unknown[] }).buysAfter as Record<string, unknown>[]) : [];
    for (const a of buysAfter.slice(0, 20)) {
      const store = typeof a?.store === "string" ? a.store : "";
      if (!store) continue;
      const at = typeof a.at === "string" ? a.at : "";
      const id = typeof a.id === "string" ? a.id : "";
      buys.push(...(await hub.buys(store, { at, id })).map((b) => ({ store, ...b })));
    }
    // Selling days (sales, cost, expenses, profit): only when the hub asks, since it is a report, not a beat.
    const days = [];
    const wanted = (got as { daysWanted?: unknown }).daysWanted;
    if (typeof wanted === "number" && wanted > 0) {
      for (const store of stores) days.push(...(await hub.days(store, wanted)).map((d) => ({ store, ...d })));
    }
    const answer = await send(door, {
      method: "POST",
      headers,
      body: JSON.stringify({ results, products, updates: updates.slice(0, 200), ...(customers.length ? { customers } : {}), ...(buys.length ? { buys } : {}), ...(refusedTaps.length ? { taps: refusedTaps } : {}), ...(truckAnswers.length ? { truck: truckAnswers } : {}), ...(changeAnswers.length ? { changes: changeAnswers } : {}), ...(days.length ? { days } : {}) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!answer.ok) throw new Error(`hub answered ${answer.status}`);
    link.lastOkAt = new Date().toISOString();
    link.lastError = null;
  } catch (e) {
    link.lastError = linkError(e);
    throw e;
  }
}

let runBeat: ((full: boolean) => Promise<void>) | null = null;

/**
 * Starts the hub beat: every `everyMs` ask for waiting orders, and once a minute (or when orders came) send items
 * and how the hub orders stand. A slow hub never stacks beats on top of each other.
 */
export function startHubSync(hub: HubOrderService, hubUrl: string, secret: string, everyMs: number): void {
  link.on = true;
  const fullEvery = Math.max(1, Math.round(60_000 / everyMs));
  let n = 0;
  let running: Promise<void> | null = null;
  runBeat = (full) => {
    if (running) return running;
    running = syncWithHub(hub, hubUrl, secret, fetch, { full })
      .catch((e: Error) => console.warn(`[sam-store] hub sync: ${e.message}`))
      .finally(() => { running = null; });
    return running;
  };
  const beat = () => void runBeat?.(n++ % fullEvery === 0);
  setTimeout(beat, 5_000).unref?.();
  setInterval(beat, everyMs).unref?.();
}

/**
 * Something the hub copies just changed here (a selling price, stock, an order's step): send it in a few seconds
 * instead of waiting for the minute. Many changes in a row make one send.
 */
let nudge: ReturnType<typeof setTimeout> | null = null;
export function hubNudge(delayMs = 3_000): void {
  if (!runBeat || nudge) return;
  nudge = setTimeout(() => {
    nudge = null;
    void runBeat?.(true);
  }, delayMs);
  nudge.unref?.();
}

/** "Check now" on the Orders screen: one full beat right away (or the one already running). False when off. */
export async function hubSyncNow(): Promise<boolean> {
  if (!runBeat) return false;
  await runBeat(true);
  return true;
}
