export interface CategoryDTO {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
}

export interface ProductVariantDTO {
  id: string;
  name: string;
  sku: string;
  priceMinor: number;
  availableQuantity: number;
}

export interface ProductAddonDTO {
  id: string;
  name: string;
  required: boolean;
  options: { id: string; name: string; priceMinor: number }[];
}

export interface ProductDTO {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  /** integer minor units (cents) */
  priceMinor: number;
  category: CategoryDTO | null;
  images: { url: string; sortOrder: number }[];
  /** quantityOnHand minus quantityReserved; null when unlimited */
  availableQuantity: number | null;
  variants: ProductVariantDTO[];
  addons: ProductAddonDTO[];
}

export interface PublicStoreDTO {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  currencyCode: string;
  timezone: string;
  guestOrderingEnabled: boolean;
  orderingPaused: boolean;
  closedStoreMessage: string | null;
  deliveryFeeMinor: number;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  minOrderAmountMinor: number;
  accentColor?: string | null;
  bannerText?: string | null;
}

export interface CartLineDTO {
  lineId: string;
  productId: string;
  sku: string;
  name: string;
  unitPriceMinor: number;
  variantId: string | null;
  variant: { id: string; name: string; sku: string } | null;
  addons: { addonId: string; optionId: string; name: string; priceMinor: number }[];
  addonsTotalMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

export interface CartDTO {
  token: string;
  storeId: string;
  lines: CartLineDTO[];
  subtotalMinor: number;
}

export interface CartItemDTO {
  lineId: string;
  productId: string;
  sku: string;
  name: string;
  unitPriceMinor: number;
  variantId: string | null;
  variant: { id: string; name: string; sku: string } | null;
  addons: { addonId: string; optionId: string; name: string; priceMinor: number }[];
  addonsTotalMinor: number;
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

export interface CheckoutRequest {
  cartToken: string;
  customerName: string;
  customerPhone: string;
  deliveryAddressLine1: string;
  deliveryAddressLine2?: string;
  landmark?: string;
  deliverySchedule?: string;
  notes?: string;
  paymentMethod: "cod";
  idempotencyKey: string;
}

export interface CheckoutResponse {
  orderId: string;
  orderNumber: string;
  status: "RECEIVED";
  totalMinor: number;
  currencyCode: string;
  claimToken: string;
  /** present when the server re-priced the cart at checkout time */
  priceChanges?: { productId: string; fromMinor: number; toMinor: number }[];
  /** present when an item became unavailable and was dropped */
  removedProductIds?: string[];
}