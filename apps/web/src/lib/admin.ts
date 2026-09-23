// Admin helpers — calls the protected admin API.
import { API_URL } from "../config";

/** Active store id from the session (set by the store switcher). */
export function getAdminStoreId(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem("samstore.admin.storeId");
}

export function setAdminStoreId(storeId: string) {
  try { sessionStorage.setItem("samstore.admin.storeId", storeId); } catch { /* ignore */ }
}

/** Auth + tenant headers for admin API calls. */
export function adminHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getAdminToken()}` };
  const storeId = getAdminStoreId();
  if (storeId) headers["X-Store-Id"] = storeId;
  return headers;
}

export interface AdminOrder {
  id: string;
  orderNumber: string;
  status: string;
  totalMinor: number;
  currencyCode: string;
  customerName: string;
  customerPhone: string;
  createdAt: string;
  paymentStatus?: string;
  source?: string;
  deliveryType?: string;
  paymentMethod?: string;
  signatureData?: string;
  signatureAt?: string;
  // Detail-only (populated by GET /admin/orders/:id)
  deliveryAddressLine1?: string | null;
  deliveryAddressLine2?: string | null;
  landmark?: string | null;
  notes?: string | null;
  subtotalMinor?: number;
  deliveryFeeMinor?: number;
  discountMinor?: number;
  items?: { productName: string; quantity: number; lineTotalMinor: number }[];
  statusHistory?: { fromStatus: string | null; toStatus: string; createdAt: string; reason?: string | null; actorType?: string }[];
  claimTokens?: { token: string; usedAt: string | null }[];
}

/** Loads the admin token from session storage (client-side only). */
export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem("samstore.admin.token");
}

/** Decodes the role claim from the stored admin JWT (best-effort). */
export function getAdminRole(): string {
  const token = getAdminToken();
  if (!token) return "";
  try {
    const parts = token.split(".");
    if (parts.length < 2) return "";
    const payloadPart = parts[1] ?? "";
    if (!payloadPart) return "";
    const payload = JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")));
    return payload.role ?? "";
  } catch {
    return "";
  }
}

// ─────────────────────────────── Role-scoped navigation (U1/U2) ───────────────────────────────
// Truth source: LIVE permission probes against the API per role (2026-09-04). Do not guess.

export interface NavItem {
  id: string;
  label: string;
  icon: string;
}

export interface NavGroup {
  group: string;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    group: "overview",
    label: "Overview",
    items: [
      { id: "overview", label: "Overview", icon: "bi-speedometer2" },
    ],
  },
  {
    group: "sell",
    label: "Sell",
    items: [
      { id: "pos", label: "POS", icon: "bi-cash-register" },
      { id: "preorders", label: "Pre Order", icon: "bi-bag-check" },
    ],
  },
  {
    group: "manage",
    label: "Manage",
    items: [
      { id: "orders", label: "Orders", icon: "bi-receipt" },
      { id: "utang", label: "Credit Ledger", icon: "bi-journal-text" },
      { id: "products", label: "Products", icon: "bi-box-seam" },
      { id: "inventory", label: "Inventory", icon: "bi-boxes" },
      { id: "expenses", label: "Expenses", icon: "bi-receipt-cutoff" },
      { id: "purchases", label: "Purchases", icon: "bi-cart4" },
      { id: "team", label: "Team", icon: "bi-people" },
      { id: "customers", label: "Customers", icon: "bi-people-fill" },
      { id: "vouchers", label: "Vouchers", icon: "bi-ticket-perforated" },
      { id: "crm", label: "CRM", icon: "bi-people-heart" },
      { id: "erp", label: "ERP & BIR", icon: "bi-journal-check" },
    ],
  },
  {
    group: "store",
    label: "Store",
    items: [
      { id: "analytics", label: "Analytics", icon: "bi-graph-up-arrow" },
      { id: "reports", label: "Reports", icon: "bi-file-bar-graph" },
      { id: "settings", label: "Settings", icon: "bi-gear" },
      { id: "storelink", label: "Store Link", icon: "bi-link-45deg" },
    ],
  },
  {
    group: "system",
    label: "System",
    items: [
      { id: "useraccess", label: "User Access", icon: "bi-person-badge" },
      { id: "warehouses", label: "Warehouses", icon: "bi-archive" },
      { id: "stores", label: "Stores", icon: "bi-shop-window" },
      { id: "maintenance", label: "Maintenance", icon: "bi-tools" },
    ],
  },
];

/** Tab visibility per staff role (GET-level permissions from live API probes). */
export const TABS_BY_ROLE: Record<string, string[]> = {
  // M7: OWNER is the tenant (store membership) role; STORE_OWNER is the legacy global
  // role — both are store owners and must see the same surface.
  STORE_OWNER: ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "expenses", "purchases", "team", "customers", "vouchers", "crm", "erp", "analytics", "reports", "settings", "storelink", "warehouses", "stores", "maintenance", "useraccess"],
  OWNER: ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "expenses", "purchases", "team", "customers", "vouchers", "crm", "erp", "analytics", "reports", "settings", "storelink", "warehouses", "stores", "maintenance", "useraccess"],
  PLATFORM_ADMIN: ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "expenses", "purchases", "team", "customers", "vouchers", "crm", "erp", "analytics", "reports", "settings", "storelink", "warehouses", "stores", "maintenance", "useraccess"],
  MANAGER: ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "expenses", "purchases", "team", "customers", "vouchers", "crm", "erp", "analytics", "reports", "settings", "warehouses", "maintenance"],
  STAFF: ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "expenses", "purchases", "team", "customers", "vouchers", "crm", "erp", "analytics", "reports", "settings", "warehouses", "maintenance"],
  SALES_AGENT: ["orders", "team", "reports"],
  DELIVERY: [],
};

/** A store owner is either the tenant role OWNER or the legacy global STORE_OWNER. */
export const isOwnerRole = (role: string) => role === "OWNER" || role === "STORE_OWNER";

/** Write-level permissions (from live write probes). */
export function roleCan(role: string, action: "manageTeam" | "manageLink" | "voidRefund" | "write" | "profit"): boolean {
  const owner = isOwnerRole(role);
  switch (action) {
    case "manageTeam": return owner || role === "PLATFORM_ADMIN";
    case "manageLink": return owner || role === "PLATFORM_ADMIN";
    case "voidRefund": return owner || role === "PLATFORM_ADMIN" || role === "MANAGER";
    case "profit": return owner || role === "PLATFORM_ADMIN" || role === "MANAGER";
    case "write": return owner || role === "PLATFORM_ADMIN" || role === "MANAGER" || role === "STAFF";
    default: return false;
  }
}

/** Default landing tab per role. */
export function defaultTabFor(role: string): string {
  const tabs = TABS_BY_ROLE[role] ?? [];
  if (tabs.length === 0) return "orders";
  if (tabs.includes("overview")) return "overview";
  return tabs[0] ?? "orders";
}

export function allowedTabs(role: string): string[] {
  return TABS_BY_ROLE[role] ?? [];
}

/** Fetches orders for the admin dashboard (demo: reads from API; auth via token). */
export async function fetchAdminOrders(token: string): Promise<AdminOrder[]> {
  const res = await fetch(`${API_URL}/admin/orders`, {
    headers: adminHeaders(),
  });
  if (!res.ok) throw new Error("Failed to load orders: " + res.status);
  const data = await res.json();
  return (data.orders ?? []).map((o: any) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    totalMinor: o.totalMinor,
    currencyCode: o.currencyCode,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    createdAt: o.createdAt,
  }));
}