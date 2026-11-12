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

/** Where lib/offlineCache.ts keeps the screens' saved copies. */
export const SAVED_COPY_PREFIX = "rice-cache-v1:";

/** Forget the sign-in, the chosen store and the screens' saved copies on this phone. */
export function clearAdminSession() {
  setHomeLocation(null); // the next login may belong to another store
  removeAuthItem("samstore.admin.token");
  removeAuthItem("samstore.admin.storeId");
  try {
    const ls = window.localStorage;
    for (let i = ls.length - 1; i >= 0; i--) { const k = ls.key(i); if (k?.startsWith(SAVED_COPY_PREFIX)) ls.removeItem(k); }
  } catch { /* nothing saved */ }
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
  /** Orders from SE Corp Hub: the channel, the selling page and the hub's own reference. */
  sourceChannel?: string | null;
  sourcePage?: string | null;
  externalRef?: string | null;
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
  /** The list sends name + quantity only; the order's own page adds the money columns. */
  items?: { productName: string; quantity: number; lineTotalMinor?: number; unitPriceMinor?: number; priceOverridden?: boolean; priceOverrideReason?: string | null }[];
  /** M3: the explicit DELIVERY | PICKUP (deliveryType defaults to "delivery" even for counter holds). */
  fulfillmentType?: string | null;
  statusHistory?: { fromStatus: string | null; toStatus: string; createdAt: string; reason?: string | null; actorType?: string }[];
  claimTokens?: { token: string; usedAt: string | null }[];
}

/** Loads the admin token from the phone's storage (client-side only). */
export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  return getAuthItem("samstore.admin.token");
}

function tokenClaim(claim: "role" | "sub"): string {
  const token = getAdminToken();
  if (!token) return "";
  try {
    const parts = token.split(".");
    if (parts.length < 2) return "";
    const payloadPart = parts[1] ?? "";
    if (!payloadPart) return "";
    const payload = JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload[claim] === "string" ? payload[claim] : "";
  } catch {
    return "";
  }
}

/** Decodes the role claim from the stored admin JWT (best-effort). */
export function getAdminRole(): string {
  return tokenClaim("role");
}

/** The signed-in login (its id in the stored JWT), "" when nobody is signed in. */
export function getAdminUserId(): string {
  return tokenClaim("sub");
}

// ─────────────────────────────── Role-scoped navigation (U1/U2) ───────────────────────────────
// Truth source: LIVE permission probes against the API per role (2026-09-04). Do not guess.

/**
 * What a screen is for, as a colour the whole app repeats (easy-to-read pass, 2026-10-31):
 * sell = green, money = amber, stock = blue, report = purple, setup = dark ink. Shown on the Home
 * tiles, the menu, the bottom bar and the top bar, always next to the screen's name and icon.
 */
export type NavTone = "sell" | "money" | "stock" | "report" | "setup";

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  /** One plain line on what the owner does on this screen (top bar, under the name). */
  hint?: string;
}

export interface NavGroup {
  group: string;
  label: string;
  tone: NavTone;
  icon: string;
  items: NavItem[];
}

// Screens grouped by what they are FOR (Sell, Money, Stock, Reports, People & settings), in the
// order of a store day. The same groups, colours and hints show on Home, in the menu and in the
// top bar, so the owner learns one map of the app. Which screens a role sees is still TABS_BY_ROLE.
export const NAV_GROUPS: NavGroup[] = [
  {
    group: "sell",
    label: "Sell",
    tone: "sell",
    icon: "bi-basket",
    items: [
      { id: "pos", label: "POS", icon: "bi-basket", hint: "Sell rice at the counter" },
      { id: "preorders", label: "Pre-order", icon: "bi-bag-check", hint: "Take an order for later" },
      { id: "orders", label: "Orders", icon: "bi-receipt", hint: "Online and agent orders, next step" },
      { id: "agentorders", label: "Agent orders", icon: "bi-person-lines-fill", hint: "Orders sent in by sales agents" },
      { id: "agent", label: "New order (agent)", icon: "bi-phone", hint: "Write a new order for a customer" },
    ],
  },
  {
    group: "money",
    label: "Money",
    tone: "money",
    icon: "bi-cash-coin",
    items: [
      { id: "utangrice", label: "Credit", icon: "bi-journal-text", hint: "Who owes the store; take payments" }, // Credit + Credit Ledger, merged
      { id: "payable", label: "Store payable", icon: "bi-cash-coin", hint: "What each store owes the main store" },
      { id: "approvals", label: "For your approval", icon: "bi-inbox", hint: "Requests waiting for your yes or no" },
      { id: "cash", label: "Cash drawer", icon: "bi-safe", hint: "Cash that should be in the drawer; cash handed to the owner" },
      { id: "expenses", label: "Expenses", icon: "bi-receipt-cutoff", hint: "Money the store paid out" },
      { id: "purchases", label: "Purchases", icon: "bi-cart4", hint: "Stock bought and what was paid" },
      { id: "purchaseorders", label: "Supplier orders", icon: "bi-truck", hint: "Orders sent to suppliers" },
    ],
  },
  {
    group: "stock",
    label: "Stock",
    tone: "stock",
    icon: "bi-boxes",
    items: [
      { id: "resack", label: "Resack", icon: "bi-arrow-repeat", hint: "Open a sack into smaller bags" },
      { id: "moves", label: "Move stock", icon: "bi-arrow-left-right", hint: "Send rice from one store to another" },
      { id: "returns", label: "Customer returns", icon: "bi-arrow-return-left", hint: "Rice a customer brought back" },
      { id: "pasok", label: "Stock in", icon: "bi-box-arrow-in-down", hint: "Rice that arrived: check and stock it" },
      { id: "bilangin", label: "Count", icon: "bi-clipboard-check", hint: "Count the shelf and fix the numbers" },
      { id: "inventory", label: "Inventory", icon: "bi-boxes", hint: "How much rice is in each store" },
      { id: "products", label: "Products", icon: "bi-box-seam", hint: "Kinds of rice, prices and costs" },
      { id: "storeprices", label: "Store prices", icon: "bi-tags", hint: "Each store's own selling prices" },
      { id: "drafts", label: "To finish", icon: "bi-hourglass-split", hint: "Work started and not finished" },
      { id: "kargadors", label: "Porters", icon: "bi-person-walking", hint: "Porters and what they carried" },
      { id: "warehouses", label: "Locations", icon: "bi-geo-alt", hint: "The stores and warehouse you use" },
    ],
  },
  {
    group: "reports",
    label: "Reports",
    tone: "report",
    icon: "bi-bar-chart-line",
    items: [
      { id: "overview", label: "Overview", icon: "bi-speedometer2", hint: "How the store is doing today" },
      { id: "storereport", label: "Store report", icon: "bi-shop", hint: "One store's sales and stock" },
      { id: "ulat", label: "Reports & closing", icon: "bi-bar-chart-line", hint: "Close the day and see reports" },
      { id: "reports", label: "Reports", icon: "bi-file-bar-graph", hint: "Sales, credit and stock by date" },
      { id: "analytics", label: "Analytics", icon: "bi-graph-up-arrow", hint: "Trends across the platform" },
      { id: "export", label: "Export data", icon: "bi-download", hint: "Excel file of sales, stock and money" },
    ],
  },
  {
    group: "setup",
    label: "People & settings",
    tone: "setup",
    icon: "bi-gear",
    items: [
      { id: "customers", label: "Customers", icon: "bi-people-fill", hint: "Customers, credit limits, loyalty" },
      { id: "team", label: "Team", icon: "bi-people", hint: "Staff accounts, roles and PINs" },
      { id: "settings", label: "Settings", icon: "bi-gear", hint: "Store name, receipts, printer" },
      { id: "countersettings", label: "Counter & printer", icon: "bi-sliders", hint: "Cash drawer and printer here" },
      { id: "storelink", label: "Store Link", icon: "bi-link-45deg", hint: "Web link and QR code for customers" },
      // Vouchers, CRM and ERP & BIR are hidden: no role list includes them. Add the id to OWNER_TABS to show one again.
      { id: "vouchers", label: "Vouchers", icon: "bi-ticket-perforated", hint: "Discount vouchers for customers" },
      { id: "crm", label: "CRM", icon: "bi-people-heart", hint: "Customer messages and campaigns" },
      { id: "erp", label: "ERP & BIR", icon: "bi-journal-check", hint: "Accounting entries and BIR reports" },
    ],
  },
  {
    group: "system",
    label: "System",
    tone: "setup",
    icon: "bi-tools",
    items: [
      { id: "useraccess", label: "User Access", icon: "bi-person-badge", hint: "Who can sign in to the platform" },
      { id: "stores", label: "Stores", icon: "bi-shop-window", hint: "All stores on the platform" },
      { id: "maintenance", label: "Maintenance", icon: "bi-tools", hint: "Platform checks and repairs" },
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

/** The group a screen belongs to (its colour and group name), for the top bar, Home and the menu. */
export function navGroupFor(id: string): NavGroup | undefined {
  return NAV_GROUPS.find((g) => g.items.some((i) => i.id === id));
}

/** The colour meaning of a screen; "setup" (dark ink) when the screen is not in the menu. */
export function toneFor(id: string): NavTone {
  return navGroupFor(id)?.tone ?? "setup";
}

const OWNER_TABS = ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "cash", "expenses", "purchases", "team", "customers", "analytics", "reports", "settings", "storelink", "warehouses", "approvals", "moves", "returns", "resack", "drafts", "kargadors", "pasok", "purchaseorders", "utangrice", "agentorders", "bilangin", "storereport", "payable", "ulat", "export", "storeprices"];

/** Tab visibility per staff role (GET-level permissions from live API probes). */
export const TABS_BY_ROLE: Record<string, string[]> = {
  // M7: OWNER is the tenant (store membership) role; STORE_OWNER is the legacy global
  // role — both are store owners and must see the same surface.
  STORE_OWNER: OWNER_TABS,
  OWNER: OWNER_TABS,
  // Platform operators manage tenants/access and monitor the platform; daily POS/catalog tabs belong to store roles.
  PLATFORM_ADMIN: ["overview", "stores", "useraccess", "maintenance", "analytics", "reports", "settings"],
  MANAGER: OWNER_TABS.filter((t) => t !== "storelink" && t !== "export"), // export carries costs + every customer: owner only
  STAFF: ["overview", "pos", "preorders", "orders", "utang", "products", "inventory", "cash", "expenses", "purchases", "customers", "reports", "countersettings", "moves", "returns", "resack", "drafts", "kargadors", "pasok", "utangrice", "agentorders", "bilangin", "storereport", "ulat"],
  SALES_AGENT: ["agent", "overview", "orders", "customers", "reports"],
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

// Per-store build, step 6 (the wall): a login tied to one store does not get the screens that show
// the whole business. The server refuses them too; this only keeps them out of the menu.
const WHOLE_BUSINESS_TABS = ["purchases", "purchaseorders", "reports", "analytics", "export"];
const HOME_KEY = "sam.homeLocationId";
const HEAD_KEY = "sam.isStoreHead";
let homeLocationId: string | null | undefined;
let storeHead: boolean | undefined;

/** Remember the login's home store and whether it is the head of that store (from GET /admin/me/rice). Saved, so the menu is right before the server answers next time. */
export function setHomeLocation(id: string | null, isHead = false): void {
  homeLocationId = id;
  storeHead = !!id && isHead;
  try {
    if (id) window.localStorage.setItem(HOME_KEY, id); else window.localStorage.removeItem(HOME_KEY);
    if (storeHead) window.localStorage.setItem(HEAD_KEY, "1"); else window.localStorage.removeItem(HEAD_KEY);
  } catch { /* private window: the menu is right once the server answers */ }
}
/** Step 7: is this login the head of its store? (The server decides what a head may do; this only shapes the menu.) */
export function isStoreHead(): boolean {
  if (storeHead === undefined) {
    try { storeHead = typeof window !== "undefined" && window.localStorage.getItem(HEAD_KEY) === "1"; } catch { storeHead = false; }
  }
  return !!storeHead && !!homeLocation();
}
function homeLocation(): string | null {
  if (homeLocationId === undefined) {
    try { homeLocationId = typeof window === "undefined" ? null : window.localStorage.getItem(HOME_KEY); } catch { homeLocationId = null; }
  }
  return homeLocationId ?? null;
}
/** Is this login tied to one store (and not the owner or a manager)? */
export function isStoreLogin(role: string): boolean {
  return !isOwnerRole(role) && role !== "MANAGER" && role !== "PLATFORM_ADMIN" && !!homeLocation();
}

export function allowedTabs(role: string): string[] {
  const tabs = TABS_BY_ROLE[role] ?? [];
  if (!isStoreLogin(role)) return tabs;
  const own = tabs.filter((t) => !WHOLE_BUSINESS_TABS.includes(t));
  // The head of a store also gets the screen for that store's own prices.
  return role === "STAFF" && isStoreHead() ? [...own, "storeprices"] : own;
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
