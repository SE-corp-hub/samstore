// Repository contracts (domain-facing) + InMemory implementations.
// The NestJS modules depend on these INTERFACES; Prisma-backed implementations
// will replace InMemoryRepository once DATABASE_URL is live — no service changes needed.

export interface StoreRecord {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  currencyCode: string;
  timezone: string;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED" | "CLOSED";
  guestOrderingEnabled: boolean;
  orderingPaused: boolean;
  closedStoreMessage: string | null;
  deliveryFeeMinor: number;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  minOrderAmountMinor: number;
  // M4 VAT configuration (present on records coming from the store repository).
  vatEnabled?: boolean;
  vatRateBp?: number;
  pricesIncludeVat?: boolean;
  // P3b: statutory senior/PWD discount toggle
  seniorPwdDiscountEnabled?: boolean;
  /** P3i: order-number prefix — when set, numbers read PREFIX-YYYY-NNNNNN. */
  orderNumberPrefix?: string | null;
  accentColor?: string | null;
  bannerText?: string | null;
  logoUrl?: string | null;
}

export interface ProductRecord {
  id: string;
  storeId: string;
  sku: string;
  name: string;
  description: string | null;
  priceMinor: number;
  isActive: boolean;
  categoryName: string | null;
  images: string[];
  quantityOnHand: number;
  quantityReserved: number;
  /** P3d: merchandising — feature flag + free-form display tags. */
  featured: boolean;
  tags: string[];
}

export interface ProductVariantRecord {
  id: string;
  productId: string;
  name: string;
  sku: string;
  priceMinor: number;
  isActive: boolean;
  quantityOnHand: number;
  quantityReserved: number;
}

export interface AddonOptionRecord {
  id: string;
  name: string;
  priceMinor: number;
  isActive: boolean;
}

export interface AddonRecord {
  id: string;
  name: string;
  required: boolean;
  options: AddonOptionRecord[];
}

export interface CartLineRecord {
  /** stable line id (CartItem id). Present for persisted carts; optional for literals. */
  lineId?: string;
  productId: string;
  variantId?: string | null;
  addonKey?: string | null;
  addons?: unknown[] | null;
  /** per-unit add-on cost (minor units) — 0 for plain products */
  addonsTotalMinor?: number;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor?: number;
}

export interface CartRecord {
  id: string;
  storeId: string;
  token: string;
  status: "OPEN" | "CONVERTED" | "ABANDONED" | "EXPIRED";
  expiresAt?: Date | null;
  lines: CartLineRecord[];
}

export interface OrderRecord {
  id: string;
  orderNumber: string;
  storeId: string;
  status: string;
  currencyCode: string;
  deliveryType?: string;
  subtotalMinor: number;
  deliveryFeeMinor: number;
  discountMinor: number;
  totalMinor: number;
  /** M4: the frozen VAT breakdown — required on writes, defaulted to 0 for legacy readers. */
  vatableMinor?: number;
  vatMinor?: number;
  vatExemptMinor?: number;
  vatRateBp?: number;
  snapshot: unknown;
  paymentMethod: string;
  paymentStatus: string;
  idempotencyKey: string;
  cartToken: string;
  storeCustomerId?: string | null;
  customerName: string;
  customerPhone: string;
  deliveryAddressLine1: string;
  deliveryAddressLine2: string | null;
  landmark: string | null;
  deliverySchedule: string | null;
  notes: string | null;
  /** P1: PH address hierarchy codes + frozen name snapshot (null = legacy free-text). */
  deliveryRegionCode?: string | null;
  deliveryProvinceCode?: string | null;
  deliveryCityCode?: string | null;
  deliveryBarangayCode?: string | null;
  deliveryRegionName?: string | null;
  deliveryProvinceName?: string | null;
  deliveryCityName?: string | null;
  deliveryBarangayName?: string | null;
  /** P5a: delivery zone snapshot (name + ETA) when the store prices by zone. */
  deliveryZoneName?: string | null;
  etaMinutes?: number | null;
  /** P3b: statutory 20% discount capture (senior/pwd + ID + cardholder name). */
  statutoryType?: string | null;
  statutoryId?: string | null;
  statutoryName?: string | null;
  claimToken: string | null;
  items: {
    productId: string | null;
    productName: string;
    sku: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    /** P2a: immutable variant + add-on snapshot (names/prices frozen with the sale). */
    variantId?: string | null;
    variantName?: string | null;
    addons?: unknown[] | null;
  }[];
  createdAt: Date;
}

export interface StoreRepository {
  findBySlug(slug: string): Promise<StoreRecord | null>;
  findById(id: string): Promise<StoreRecord | null>;
}

export interface CatalogRepository {
  listActiveProducts(storeId: string): Promise<ProductRecord[]>;
  getProductsByIds(storeId: string, ids: string[]): Promise<ProductRecord[]>;
  /** Cross-store lookup — used only to bind a fresh cart to the product's store on first add. */
  getProductById(id: string): Promise<ProductRecord | null>;
  /** P2a: variant lookups (price + stock) — tenant-scoped. */
  getVariantById(id: string): Promise<ProductVariantRecord | null>;
  getVariantsByIds(storeId: string, ids: string[]): Promise<ProductVariantRecord[]>;
  /** P2a: all variants for a set of products (storefront payload). */
  getVariantsByProductIds(storeId: string, productIds: string[]): Promise<ProductVariantRecord[]>;
  /** P2a: add-on groups + active options for a product. */
  getProductAddons(storeId: string, productId: string): Promise<AddonRecord[]>;
  /** P3d: related/upsell links for a set of products (same store), ordered by sortOrder. */
  getProductRelations(
    storeId: string,
    sourceProductIds: string[],
    kinds: ("related" | "upsell")[],
  ): Promise<{ sourceProductId: string; kind: "related" | "upsell"; targetProductId: string }[]>;
}

export interface CartRepository {
  findByToken(token: string): Promise<CartRecord | null>;
  /** Create a cart (must be unique token); storeId bound on first add. */
  create(cart: CartRecord): Promise<CartRecord>;
  /** Add/upsert a line keyed by (productId, variantId, addonKey); unit price is the
   *  variant/ product price; add-on costs are stored separately (addonsTotalMinor). */
  addItem(cartId: string, storeId: string, productId: string, quantity: number, unitPriceMinor: number, opts?: {
    variantId?: string | null;
    addonKey?: string | null;
    addons?: unknown[] | null;
    addonsTotalMinor?: number;
  }): Promise<void>;
  updateItemQuantity(lineId: string, quantity: number): Promise<void>;
  removeItem(lineId: string): Promise<void>;
  save(cart: CartRecord): Promise<void>;
}

export interface OrderSequenceRepository {
  nextOrderSequence(storeId: string): Promise<number>;
}

export interface OrderRepository {
  create(order: OrderRecord): Promise<OrderRecord>;
  /** Module 5: create the order AND all checkout side effects in ONE transaction. */
  createAtomic?(order: OrderRecord, effects: AtomicCheckoutEffects): Promise<OrderRecord>;
  findByIdempotencyKey(key: string): Promise<OrderRecord | null>;
  markClaimTokenUsed(orderId: string, token: string): Promise<void>;
}

/** Module 5 — the side effects of a checkout that MUST be atomic with order creation. */
export interface AtomicCheckoutEffects {
  /** Convert the cart (status → CONVERTED) in the same transaction. */
  cart?: { token: string; storeId: string };
  /** Reserve stock: quantityReserved += qty + a RESERVE movement per row.
   *  variantId set → reserves the variant's own counters (P2a); otherwise the product StockLevel. */
  stockReservations?: { productId: string; variantId?: string | null; quantity: number }[];
  /** Record voucher redemption (one row per (voucher, order)) + per-customer accounting (P3a). */
  voucherRedemption?: { voucherId: string; storeCustomerId?: string | null };
  /** Deduct loyalty points + write the REDEEM ledger entry. */
  loyalty?: { customerId: string; storeCustomerId: string; points: number };
  /** Create the credit (utang) purchase entry + increment the customer balance. */
  credit?: { storeCustomerId: string; amountMinor: number };
}

// ─────────────────────────────── InMemory ───────────────────────────────

import { randomUUID } from "node:crypto";

export class InMemoryStoreRepository implements StoreRepository {
  private store = new Map<string, StoreRecord>();

  seed(...stores: StoreRecord[]) {
    for (const s of stores) {
      this.store.set(s.slug, s);
      this.store.set(s.id, s);
    }
  }

  async findBySlug(slug: string): Promise<StoreRecord | null> {
    return this.store.get(slug) ?? null;
  }
  async findById(id: string): Promise<StoreRecord | null> {
    return this.store.get(id) ?? null;
  }
}

export class InMemoryCatalogRepository implements CatalogRepository {
  private byId = new Map<string, ProductRecord>();

  seed(...products: ProductRecord[]) {
    for (const p of products) this.byId.set(p.id, p);
  }

  async listActiveProducts(storeId: string): Promise<ProductRecord[]> {
    return [...this.byId.values()].filter(
      (p) => p.storeId === storeId && p.isActive,
    );
  }
  async getProductsByIds(storeId: string, ids: string[]): Promise<ProductRecord[]> {
    return ids
      .map((id) => this.byId.get(id))
      .filter((p): p is ProductRecord => !!p && p.storeId === storeId);
  }
  async getProductById(id: string): Promise<ProductRecord | null> {
    return this.byId.get(id) ?? null;
  }
  async getVariantById(id: string): Promise<ProductVariantRecord | null> {
    return null; // InMemory test double: no variant data
  }
  async getVariantsByIds(storeId: string, ids: string[]): Promise<ProductVariantRecord[]> {
    return []; // InMemory test double: no variant data
  }
  async getVariantsByProductIds(storeId: string, productIds: string[]): Promise<ProductVariantRecord[]> {
    return []; // InMemory test double: no variant data
  }
  async getProductAddons(storeId: string, productId: string): Promise<AddonRecord[]> {
    return []; // InMemory test double: no add-on data
  }

  async getProductRelations(storeId: string, sourceProductIds: string[], kinds: ("related" | "upsell")[]): Promise<{ sourceProductId: string; kind: "related" | "upsell"; targetProductId: string }[]> {
    return []; // InMemory test double: no relation data
  }
}

export class InMemoryCartRepository implements CartRepository {
  private byToken = new Map<string, CartRecord>();

  seed(...carts: CartRecord[]) {
    for (const c of carts) this.byToken.set(c.token, c);
  }

  async findByToken(token: string): Promise<CartRecord | null> {
    return this.byToken.get(token) ?? null;
  }
  async create(cart: CartRecord): Promise<CartRecord> {
    this.byToken.set(cart.token, cart);
    return cart;
  }
  async addItem(cartId: string, storeId: string, productId: string, quantity: number, unitPriceMinor: number, opts?: {
    variantId?: string | null;
    addonKey?: string | null;
    addons?: unknown[] | null;
    addonsTotalMinor?: number;
  }): Promise<void> {
    const cart = [...this.byToken.values()].find((c) => c.id === cartId);
    if (!cart) return;
    const existing = cart.lines.find(
      (l) => l.productId === productId && (l.variantId ?? null) === (opts?.variantId ?? null) && (l.addonKey ?? null) === (opts?.addonKey ?? null),
    );
    if (existing) {
      existing.quantity += quantity;
    } else {
      cart.lines.push({
        lineId: randomId(),
        productId,
        variantId: opts?.variantId ?? null,
        addonKey: opts?.addonKey ?? null,
        addons: opts?.addons ?? null,
        addonsTotalMinor: opts?.addonsTotalMinor ?? 0,
        quantity,
        unitPriceMinor,
      });
    }
  }
  async updateItemQuantity(lineId: string, quantity: number): Promise<void> {
    for (const cart of this.byToken.values()) {
      const line = cart.lines.find((l) => l.lineId === lineId);
      if (line) {
        line.quantity = quantity;
        return;
      }
    }
  }
  async removeItem(lineId: string): Promise<void> {
    for (const cart of this.byToken.values()) {
      const before = cart.lines.length;
      cart.lines = cart.lines.filter((l) => l.lineId !== lineId);
      if (cart.lines.length !== before) return;
    }
  }
  async save(cart: CartRecord): Promise<void> {
    this.byToken.set(cart.token, cart);
  }
}

export class InMemoryOrderSequenceRepository implements OrderSequenceRepository {
  private seq = new Map<string, number>();
  async nextOrderSequence(storeId: string): Promise<number> {
    const next = (this.seq.get(storeId) ?? 0) + 1;
    this.seq.set(storeId, next);
    return next;
  }
}

export class InMemoryOrderRepository implements OrderRepository {
  private orders: OrderRecord[] = [];
  private byIdem = new Map<string, OrderRecord>();
  private usedClaimTokens = new Set<string>();
  /** Module 5: side effects recorded by createAtomic (for test asserts). */
  atomicEffects: (Required<AtomicCheckoutEffects> & { orderNumber: string })[] = [];

  seed(...orders: OrderRecord[]) {
    for (const o of orders) {
      this.orders.push(o);
      this.byIdem.set(o.idempotencyKey, o);
    }
  }

  async create(order: OrderRecord): Promise<OrderRecord> {
    this.orders.push(order);
    this.byIdem.set(order.idempotencyKey, order);
    return order;
  }

  /** Atomic checkout: records the order + all side effects in one "transaction". */
  async createAtomic(order: OrderRecord, effects: AtomicCheckoutEffects): Promise<OrderRecord> {
    if (this.byIdem.has(order.idempotencyKey)) {
      // Simulated unique violation → idempotent retry returns the existing order.
      return this.byIdem.get(order.idempotencyKey)!;
    }
    this.orders.push(order);
    this.byIdem.set(order.idempotencyKey, order);
    this.atomicEffects.push({
      orderNumber: order.orderNumber,
      cart: effects.cart ?? { token: "", storeId: "" },
      stockReservations: effects.stockReservations ?? [],
      voucherRedemption: effects.voucherRedemption ?? { voucherId: "" },
      loyalty: effects.loyalty ?? { customerId: "", storeCustomerId: "", points: 0 },
      credit: effects.credit ?? { storeCustomerId: "", amountMinor: 0 },
    });
    return order;
  }

  async findByIdempotencyKey(key: string): Promise<OrderRecord | null> {
    return this.byIdem.get(key) ?? null;
  }
  async markClaimTokenUsed(orderId: string, token: string): Promise<void> {
    this.usedClaimTokens.add(`${orderId}:${token}`);
  }
  exportedForTests() {
    return { orders: [...this.orders], usedClaimTokens: [...this.usedClaimTokens] };
  }
}

export function randomId(): string {
  return randomUUID();
}