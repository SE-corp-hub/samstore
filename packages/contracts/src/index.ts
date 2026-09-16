// @sam-store/contracts — shared domain types & DTOs.
// Single source of truth for the Thin Slice API surface.
// Money: integer minor units (cents) everywhere — never floats.

// ─────────────────────────────── Catalog ───────────────────────────────

export interface CategoryDTO {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
}

export interface ProductDTO {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  /** integer minor units */
  priceMinor: number;
  category: CategoryDTO | null;
  images: { url: string; sortOrder: number }[];
  /** quantityOnHand minus quantityReserved; null when unlimited */
  availableQuantity: number | null;
}

export interface PublicStoreDTO {
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  currencyCode: string;
  timezone: string;
  /** true when the store accepts guest orders via the public link */
  guestOrderingEnabled: boolean;
  orderingPaused: boolean;
  closedStoreMessage: string | null;
  deliveryFeeMinor: number;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  minOrderAmountMinor: number;
}

// ─────────────────────────────── Cart ───────────────────────────────

export interface CartLineDTO {
  productId: string;
  sku: string;
  name: string;
  /** snapshot of unit price at add-time, integer minor units */
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

export interface CartDTO {
  token: string;
  storeId: string;
  lines: CartLineDTO[];
  subtotalMinor: number;
}

/** Result of server-side revalidation before checkout (AGENTS.md: never charge a stale total). */
export interface CartRevalidationDTO {
  lines: CartLineDTO[];
  subtotalMinor: number;
  /** products whose price changed since added; new prices already applied */
  priceChanges: { productId: string; fromMinor: number; toMinor: number }[];
  /** inactive/removed products dropped from the cart */
  removedProductIds: string[];
}

export interface AddToCartRequest {
  productId: string;
  quantity: number;
}

export interface UpdateCartItemRequest {
  quantity: number;
}

export interface CreateCartResponse {
  token: string;
}

export interface CartItemDTO {
  productId: string;
  sku: string;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

export interface CartWithItemsDTO {
  token: string;
  storeId: string;
  status: "OPEN" | "CONVERTED" | "ABANDONED" | "EXPIRED";
  items: CartItemDTO[];
  subtotalMinor: number;
}

// ─────────────────────────────── Checkout (COD, slice scope) ───────────────────────────────

export interface CheckoutRequest {
  cartToken: string;
  customerName: string;
  customerPhone: string;
  deliveryAddressLine1?: string; // optional when deliveryType = pickup
  deliveryAddressLine2?: string;
  landmark?: string;
  deliverySchedule?: string;
  notes?: string;
  /** delivery | pickup (pickup: no delivery fee, address not required) — UI U5. */
  deliveryType?: "delivery" | "pickup";
  /** COD for guests/unapproved; "credit" allowed only for approved customers up to limit. */
  paymentMethod?: "cod" | "credit";
  /** client-generated; same value on retry → same order, no duplicates */
  idempotencyKey: string;
  /** optional voucher code to apply at checkout */
  voucherCode?: string;
  /** optional customer account JWT (earns/redeems loyalty) */
  customerToken?: string;
  /** optional loyalty points to redeem (requires customerToken) */
  loyaltyPoints?: number;
}

export interface CheckoutResponse {
  orderId: string;
  orderNumber: string;
  status: "RECEIVED";
  totalMinor: number;
  currencyCode: string;
  /** temporary claim token so the guest can reopen the order; single-use */
  claimToken: string;
  /** products whose price changed between cart and checkout (new prices applied);
   *  surfaced to the customer so a changed total is never a surprise (AGENTS.md). */
  priceChanges?: { productId: string; fromMinor: number; toMinor: number }[];
  /** products that became unavailable and were dropped from the order. */
  removedProductIds?: string[];
}

// ─────────────────────────────── POS (counter sales) ───────────────────────────────

export interface PosSellItem {
  productId: string;
  quantity: number;
}

export interface PosTender {
  /** A payment-method code from the store's registry (cash, gcash, credit, …). */
  methodCode: string;
  /** Amount this tender applies to the sale (minor units). */
  amountMinor: number;
  /** Cash handed over (≥ amountMinor) — the difference is change. Cash methods only. */
  tenderedMinor?: number;
  /** e-wallet / bank reference (required by methods flagged requiresReference). */
  reference?: string;
}

export interface PosSellRequest {
  /** optional store customer to link the sale to (must belong to the store) */
  customerId?: string;
  customerName?: string;
  items: PosSellItem[];
  paymentMethod: "cash" | "credit";
  /** V1: cash tendered (minor) — records a Payment row with change = tendered − total */
  tenderedMinor?: number;
  /**
   * M1: optional multi-tender payment. When present these are the tenders that settle the
   * sale (cash + gcash + utang …); `paymentMethod`/`tenderedMinor` are then ignored except
   * for the signature/loyalty rules. Counter sales must be settled in full.
   */
  tenders?: PosTender[];
  /** V1: utang start/due dates (ISO). Defaults: now / start + store creditTermDays */
  startAt?: string;
  dueAt?: string;
  /** v4: loyalty points to redeem on this sale (credit/customer only, server-validated) */
  loyaltyPoints?: number;
  /** v4: REQUIRED for credit sales — finger-drawn signature (data-URL PNG) */
  signatureData?: string;
}

export interface PosHoldRequest {
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  items: PosSellItem[];
}

export interface PosHoldItemsRequest {
  /** full replacement line set (totals + stock recomputed server-side) */
  items: PosSellItem[];
}

export interface PosHoldCompleteRequest {
  /** optional line replacement before completing (resume-edit flow) */
  items?: PosSellItem[];
  paymentMethod: "cash" | "credit";
  tenderedMinor?: number;
  /** M1: optional multi-tender payment (see PosSellRequest.tenders). */
  tenders?: PosTender[];
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  startAt?: string;
  dueAt?: string;
  /** v4: loyalty points to redeem on this completion (credit/customer only) */
  loyaltyPoints?: number;
  /** v4: REQUIRED for credit sales — finger-drawn signature (data-URL PNG) */
  signatureData?: string;
  /** When the order is delivery-type and staff collected payment at the counter: send it out for delivery (status → OUT_FOR_DELIVERY) instead of completing it. */
  sendForDelivery?: boolean;
}

export interface PosSellResponse {
  orderId: string;
  orderNumber: string;
  status: string;
  totalMinor: number;
  currencyCode: string;
  paymentMethod: "cash" | "credit";
  /** V1: change owed (cash) */
  changeMinor?: number;
  /** v4: loyalty points redeemed on this sale */
  loyaltyPointsRedeemed?: number;
}

// ─────────────────────────────── POS Pre-orders (v4) ───────────────────────────────

/** v4: create a pre-order draft — customer REQUIRED, stock reserved (ON_HOLD + source=PRE_ORDER). */
export interface PreOrderCreateRequest {
  customerId?: string; // store-customer id, OR quick-create via name/phone below
  customerName?: string;
  customerPhone?: string;
  items: PosSellItem[];
  /** default now / now + store creditTermDays */
  startAt?: string;
  dueAt?: string;
}

export interface PreOrderCreateResponse {
  orderId: string;
  orderNumber: string;
  status: string;
  totalMinor: number;
  currencyCode: string;
}

/** v4: finalize a pre-order — utang only, signature REQUIRED, order → COMPLETED + CreditEntry. */
export interface PreOrderFinalizeRequest {
  /** REQUIRED — finger-drawn signature (data-URL PNG) */
  signatureData: string;
  startAt?: string;
  dueAt?: string;
}

export interface PreOrderFinalizeResponse {
  orderId: string;
  orderNumber: string;
  status: string;
  totalMinor: number;
  currencyCode: string;
  creditEntryId: string;
  signatureAt: string;
}

// ─────────────────────────────── Admin customers / loyalty (v4) ───────────────────────────────

export interface AdminCreateCustomerRequest {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  /** v4: pre-approve for credit + optional limit (minor) */
  creditApproved?: boolean;
  creditLimitMinor?: number;
}

export interface AdminUpdateCustomerRequest {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  creditLimitMinor?: number;
}

export interface LoyaltyAdjustRequest {
  /** signed delta (can be negative; balance never below 0) */
  delta: number;
  note: string;
}

// ─────────────────────────────── Orders workflow (W1) ───────────────────────────────

export interface OrderItemsRequest {
  /** full replacement line set (totals + stock recomputed server-side) */
  items: PosSellItem[];
}

export interface OrderItemsResponse {
  id: string;
  totalMinor: number;
  status: string;
}

export interface OrderRoutingResponse {
  id: string;
  orderNumber: string;
  status: string;
  deliveryType: string;
}

export interface OrderViewDTO {
  orderNumber: string;
  status: string;
  currencyCode: string;
  subtotalMinor: number;
  deliveryFeeMinor: number;
  discountMinor: number;
  totalMinor: number;
  customerName: string;
  customerPhone: string;
  deliveryAddressLine1: string;
  deliveryAddressLine2: string | null;
  landmark: string | null;
  deliverySchedule: string | null;
  notes: string | null;
  items: {
    productName: string;
    sku: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
  }[];
  createdAt: string;
}

// ─────────────────────────────── Errors ───────────────────────────────

export type ApiError =
  | { type: "validation"; errors: string[] }
  | { type: "not_found"; message: string }
  | { type: "conflict"; message: string }
  | { type: "forbidden"; message: string }
  | { type: "unauthorized"; message: string }
  | { type: "rate_limited"; message: string };

export const PAYMENT_METHODS = ["cod"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ORDER_STATUSES = [
  "RECEIVED",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
  "FAILED_DELIVERY",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];