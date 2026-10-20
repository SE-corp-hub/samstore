// Admin helpers — calls the protected admin API.
import { API_URL } from "../config";

/**
 * The sign-in lives in the phone's own storage (localStorage), not the tab's (sessionStorage):
 * phone browsers drop background tabs often, and staff must not be asked to sign in again each time.
 * It ends when the person logs out, the token expires (the server answers 401) or the owner
 * deactivates them. A sign-in saved by an older version in sessionStorage is still read, so nobody
 * is logged out by this change.
 */
export function getAuthItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try { const v = localStorage.getItem(key); if (v !== null) return v; } catch { /* storage blocked: fall through */ }
  try { return sessionStorage.getItem(key); } catch { return null; }
}

export function setAuthItem(key: string, value: string) {
  let kept = false;
  try { localStorage.setItem(key, value); kept = true; } catch { /* storage blocked: use the tab */ }
  // Keep one copy only, so a stale tab copy can never shadow a newer sign-in.
  try { if (kept) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* ignore */ }
}

export function removeAuthItem(key: string) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}

/** Forget the sign-in and the chosen store on this phone. */
export function clearAdminSession() {
  removeAuthItem("samstore.admin.token");
  removeAuthItem("samstore.admin.storeId");
}

/** Active store id (set by the store switcher). */
export function getAdminStoreId(): string | null {
  return getAuthItem("samstore.admin.storeId");
}

export function setAdminStoreId(storeId: string) {
  setAuthItem("samstore.admin.storeId", storeId);
}

/** Auth + tenant headers for admin API calls. */
export function adminHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getAdminToken()}` };
  const storeId = getAdminStoreId();
  if (storeId) headers["X-Store-Id"] = storeId;
  return headers;
}

/**
 * Handles a 401 from any admin API call: drops the dead session and returns the
 * operator to the login screen. A token can be present but expired or signed by
 * someone else — without this the dashboard renders and every widget reports a
 * generic failure ("Failed to load overview") with no way back to login.
 * Returns true when the session was rejected, so callers can stop.
 */
export function handleUnauthorized(res: { status: number } | null | undefined): boolean {
  if (!res || res.status !== 401) return false;
  clearAdminSession();
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/admin/login")) {
    window.location.assign("/admin/login");
  }
  return true;
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

/** Loads the admin token from the phone's storage (client-side only). */
export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  return getAuthItem("samstore.admin.token");
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
      { id: "pos", label: "POS", icon: "bi-basket" },
      { id: "preorders", label: "Pre-order", icon: "bi-bag-check" },
    ],
  },
  {
    group: "rice",
    label: "Rice",
    items: [
      { id: "utangrice", label: "Credit", icon: "bi-journal-text" }, // Credit + Credit Ledger, merged (the old ledger screen is reachable as "utangold")
      { id: "agentorders", label: "Agent orders", icon: "bi-person-lines-fill" },
      { id: "agent", label: "New order (agent)", icon: "bi-phone" },
      { id: "approvals", label: "For your approval", icon: "bi-inbox" },
      { id: "trips", label: "Transfers & releases", icon: "bi-truck" },
      { id: "resack", label: "Resack", icon: "bi-arrow-repeat" },
      { id: "pasok", label: "Stock in", icon: "bi-box-arrow-in-down" },
      { id: "bilangin", label: "Count", icon: "bi-clipboard-check" },
      { id: "ulat", label: "Reports & closing", icon: "bi-bar-chart-line" },
      { id: "drafts", label: "To finish", icon: "bi-hourglass-split" },
      { id: "kargadors", label: "Porters", icon: "bi-person-walking" },
    ],
  },
  {
    group: "manage",
    label: "Manage",
    items: [
      { id: "orders", label: "Orders", icon: "bi-receipt" },
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
      { id: "countersettings", label: "Counter & printer", icon: "bi-sliders" },
      { id: "storelink", label: "Store Link", icon: "bi-link-45deg" },
    ],
  },
  {
    group: "system",
    label: "System",
    items: [
      { id: "useraccess", label: "User Access", icon: "bi-person-badge" },
      { id: "warehouses", label: "Locations", icon: "bi-geo-alt" },
      { id: "stores", label: "Stores", icon: "bi-shop-window" },
      { id: "maintenance", label: "Maintenance", icon: "bi-tools" },
    ],
  },
];

/** The nav entry for a tab id (label + icon), for the top bar title. */
export function navItemFor(id: string): NavItem | undefined {
  for (const g of NAV_GROUPS) {
    const hit = g.items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** Tab visibility per staff role (GET-level permissions from live API probes). */
export const TABS_BY_ROLE: Record<string, string[]> = {
  // M7: OWNER is the tenant (store membership) role; STORE_OWNER is the legacy global
  // role — both are store owners and must see the same surface.
  STORE_OWNER: ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "expenses", "purchases", "team", "customers", "vouchers", "crm", "erp", "analytics", "reports", "settings", "storelink", "warehouses", "approvals", "trips", "resack", "drafts", "kargadors", "benta", "posold", "utangold", "pasok", "utangrice", "agentorders", "bilangin", "ulat"],
  OWNER: ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "expenses", "purchases", "team", "customers", "vouchers", "crm", "erp", "analytics", "reports", "settings", "storelink", "warehouses", "approvals", "trips", "resack", "drafts", "kargadors", "benta", "posold", "utangold", "pasok", "utangrice", "agentorders", "bilangin", "ulat"],
  // Platform operators manage tenants/access and monitor the platform; daily POS/catalog tabs belong to store roles.
  PLATFORM_ADMIN: ["overview", "stores", "useraccess", "maintenance", "analytics", "reports", "settings"],
  MANAGER: ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "expenses", "purchases", "team", "customers", "vouchers", "crm", "erp", "analytics", "reports", "settings", "warehouses", "approvals", "trips", "resack", "drafts", "kargadors", "benta", "posold", "utangold", "pasok", "utangrice", "agentorders", "bilangin", "ulat"],
  STAFF: ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "expenses", "purchases", "customers", "reports", "countersettings", "trips", "resack", "drafts", "kargadors", "benta", "pasok", "utangrice", "agentorders", "bilangin", "ulat"],
  SALES_AGENT: ["agent", "overview", "orders", "customers", "crm", "reports"],
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
  if (role === "SALES_AGENT") return "agent"; // Rice Ops M7: the agent's three-button screen
  if (role === "STAFF" && tabs.includes("pos")) return "pos"; // counter staff start where they sell
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
