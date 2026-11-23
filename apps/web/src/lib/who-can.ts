// Who can change what (2026-11-21). ONE table for the whole app: the locked boxes, the "where it
// applies" labels and the "What I can do" guide all read it, and the server test
// (apps/api/src/auth/who-can.test.ts) checks the server answers yes or no exactly as it says.
// Plain words: the owner is 65 and reads this on the tablet.
//
// No imports on purpose: the API test reads this file directly.

/** The four kinds of login that change things. Sales agents and delivery have their own screens only. */
export type Who = "owner" | "manager" | "head" | "staff";

/** Where a change lands. */
export type Scope = "business" | "store" | "tablet" | "me";

/**
 * yes = can change. own = can change, own store only. look = can see, not change (shown locked).
 * no = not shown at all.
 */
export type Right = "yes" | "own" | "look" | "no";

export interface Rule {
  id: string;
  /** What it is, as the owner would say it. */
  what: string;
  /** Where it is in the app. */
  where: string;
  scope: Scope;
  rights: Record<Who, Right>;
}

export const RULES: Rule[] = [
  // ── Whole business ──
  { id: "businessName", what: "Business name", where: "Settings → Business name", scope: "business", rights: { owner: "yes", manager: "look", head: "no", staff: "no" } },
  { id: "vat", what: "VAT and tax", where: "Settings → VAT and tax", scope: "business", rights: { owner: "yes", manager: "look", head: "no", staff: "no" } },
  { id: "credit", what: "Credit (utang) rules for new customers", where: "Settings → Credit", scope: "business", rights: { owner: "yes", manager: "look", head: "no", staff: "no" } },
  { id: "quotaPromo", what: "Quota promo", where: "Settings → Quota promo", scope: "business", rights: { owner: "yes", manager: "look", head: "no", staff: "no" } },
  { id: "onlineShop", what: "Online shop, Messenger and points", where: "Settings → Online shop, Messenger", scope: "business", rights: { owner: "yes", manager: "look", head: "no", staff: "no" } },
  { id: "businessLock", what: "PIN lock for the whole business", where: "Settings → PIN lock", scope: "business", rights: { owner: "yes", manager: "no", head: "no", staff: "no" } },
  { id: "locations", what: "Add a store, rename it, where it takes rice from", where: "Menu → Locations", scope: "business", rights: { owner: "yes", manager: "look", head: "no", staff: "no" } },
  { id: "productAdd", what: "Add a new rice (a manager's opening stock goes to their own store; counter logins: \"+ New item\" on POS, the owner checks it)", where: "Products → New product", scope: "business", rights: { owner: "yes", manager: "yes", head: "look", staff: "look" } },
  { id: "productName", what: "A rice's name (the new name shows at every store and on receipts)", where: "Products → Manage", scope: "business", rights: { owner: "yes", manager: "yes", head: "look", staff: "look" } },
  { id: "managerProducts", what: "Let managers change everything on Products (on or off)", where: "Settings → Managers and Products", scope: "business", rights: { owner: "yes", manager: "look", head: "no", staff: "no" } },
  { id: "productSetup", what: "SKU, cost, group, sack size, per kilo, hide (a manager too, when the owner turns on Managers and Products)", where: "Products", scope: "business", rights: { owner: "yes", manager: "look", head: "look", staff: "look" } },
  { id: "productPrice", what: "Price for all stores and the main store's reorder level (a manager too, when the owner turns on Managers and Products)", where: "Products", scope: "business", rights: { owner: "yes", manager: "look", head: "look", staff: "look" } },
  { id: "productPhoto", what: "A rice's picture", where: "Products → Picture", scope: "business", rights: { owner: "yes", manager: "yes", head: "look", staff: "look" } },
  { id: "lowestPrice", what: "Lowest price a store may sell at", where: "Store prices", scope: "business", rights: { owner: "yes", manager: "look", head: "look", staff: "no" } },
  { id: "teamBig", what: "Managers, store heads, roles, which store a login works at, remove a login, reset a password", where: "Team", scope: "business", rights: { owner: "yes", manager: "no", head: "no", staff: "no" } },
  { id: "storeMoney", what: "Money between stores (store payable), supplier orders and payments, the whole business's reports", where: "Reports, Supplier orders, Store payable", scope: "business", rights: { owner: "yes", manager: "no", head: "no", staff: "no" } },
  // ── One store ──
  { id: "thisStore", what: "Open day and Z-read, drawer, per kilo, target, receipt details", where: "Settings → This store", scope: "store", rights: { owner: "yes", manager: "own", head: "own", staff: "no" } },
  { id: "storeLock", what: "The store's own PIN lock", where: "Settings → PIN lock (heads: Store PIN lock)", scope: "store", rights: { owner: "yes", manager: "own", head: "own", staff: "no" } },
  { id: "storePrice", what: "A store's own selling price", where: "Store prices, or Products → Manage (managers)", scope: "store", rights: { owner: "yes", manager: "own", head: "own", staff: "no" } },
  { id: "teamCounter", what: "Counter logins: add, name, PIN, password, unlock", where: "Team", scope: "store", rights: { owner: "yes", manager: "own", head: "own", staff: "no" } },
  // ── Work at a store (2026-11-22: everyone but the owner works at their OWN store only) ──
  { id: "storeWork", what: "Sell, pre-orders, orders, credit payments, Stock in, Count, Resack, Truck arrived, expenses and cash in", where: "POS, Pre-order, Orders, Credit, Stock in, Count, Resack", scope: "store", rights: { owner: "yes", manager: "own", head: "own", staff: "own" } },
  { id: "storeSee", what: "See a store's stock, sales, cash, Z-reads, approvals and records", where: "Inventory, Reports, For your approval", scope: "store", rights: { owner: "yes", manager: "own", head: "own", staff: "own" } },
  { id: "storeMove", what: "Move stock: send rice out of a store (the other store sends you theirs)", where: "Move stock", scope: "store", rights: { owner: "yes", manager: "own", head: "own", staff: "own" } },
  { id: "storeReorder", what: "A store's own reorder level, stock fix (Adjust)", where: "Inventory → Adjust, or Products → Manage (managers)", scope: "store", rights: { owner: "yes", manager: "own", head: "no", staff: "no" } },
  // ── This tablet / me ──
  { id: "printer", what: "Printer and receipt width", where: "Settings → Printer (or Counter & printer)", scope: "tablet", rights: { owner: "yes", manager: "yes", head: "yes", staff: "yes" } },
  { id: "account", what: "My name, email, password and PIN", where: "Settings → My account", scope: "me", rights: { owner: "yes", manager: "yes", head: "yes", staff: "yes" } },
];

export const WHO_LABEL: Record<Who, string> = { owner: "Owner", manager: "Manager", head: "Store head", staff: "Counter staff" };

/** One line on each kind of login, for the guide. */
export const WHO_SAYS: Record<Who, string> = {
  owner: "You run the whole business. You can change everything, at every store.",
  manager: "You run your own store: its sales, stock, team, prices and reports. You cannot see or change the other stores. Settings for the whole business are the owner's.",
  head: "You are in charge of your own store. You change your store's settings, prices and counter logins.",
  staff: "You sell and look after the rice at your store. Ask your store head or the owner to change a setting or a price.",
};

export const SCOPE_LABEL: Record<Scope, string> = {
  business: "Whole business",
  store: "Each store",
  tablet: "Only this tablet (or this PC)",
  me: "Only you",
};

/** One line under each scope heading. */
export const SCOPE_SAYS: Record<Scope, string> = {
  business: "Changes every store at once.",
  store: "Changes one store. The owner chooses which; everyone else works at their own store only.",
  tablet: "Changes only the tablet or PC you are using now. Others keep their own.",
  me: "Changes only your own login.",
};

/** The kind of login from the token's role and whether it is a store head. */
export function whoIs(role: string, isHead: boolean): Who | null {
  if (role === "OWNER" || role === "STORE_OWNER" || role === "PLATFORM_ADMIN") return "owner";
  if (role === "MANAGER") return "manager";
  if (role === "STAFF") return isHead ? "head" : "staff";
  return null;
}

export const ruleById = (id: string): Rule | undefined => RULES.find((r) => r.id === id);

/** The right of this login on one rule ("no" for an unknown rule or login). */
export function rightOf(who: Who | null, id: string): Right {
  const r = ruleById(id);
  return who && r ? r.rights[who] : "no";
}

/** Can this login change it (at least for its own store)? */
export const canChange = (who: Who | null, id: string): boolean => ["yes", "own"].includes(rightOf(who, id));

/** Who to ask, in the short note under a locked box. */
export function lockNote(id: string): string {
  const r = ruleById(id);
  if (!r) return "You cannot change this.";
  if (r.rights.manager === "yes" || r.rights.manager === "own") return "Only the owner or a manager can change this.";
  return "Only the owner can change this.";
}

/** The login's role in plain words, for the top bar and the menu ("STAFF" told a store head nothing). */
export function roleWord(role: string, isHead: boolean): string {
  if (role === "PLATFORM_ADMIN") return "Platform admin";
  if (role === "SALES_AGENT") return "Sales agent";
  if (role === "DELIVERY") return "Delivery";
  const who = whoIs(role, isHead);
  return who ? WHO_LABEL[who] : role;
}
