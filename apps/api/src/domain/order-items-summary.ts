// "Items in orders": how many of each product sit at each stage of the order journey, so the store can see
// at a glance what still has to be packed, what is with the courier and what was already handed over.
// The stages match the Orders screen's tabs. Cancelled orders and failed deliveries are kept apart: their
// items are not owed to anyone, so they never count toward "still to give".

export const ITEM_STAGES = ["toReceive", "inProgress", "outForDelivery", "done", "void"] as const;
export type ItemStage = (typeof ITEM_STAGES)[number];

const STAGE_OF: Record<string, ItemStage> = {
  RECEIVED: "toReceive",
  CONFIRMED: "inProgress", PREPARING: "inProgress", READY: "inProgress", ON_HOLD: "inProgress",
  OUT_FOR_DELIVERY: "outForDelivery",
  DELIVERED: "done", COMPLETED: "done",
  CANCELLED: "void", FAILED_DELIVERY: "void",
};
export const stageOfStatus = (status: string): ItemStage | null => STAGE_OF[status] ?? null;
/** Statuses whose items are still owed to the customer ("still to give"). */
export const OPEN_ITEM_STATUSES = Object.keys(STAGE_OF).filter((s) => ["toReceive", "inProgress", "outForDelivery"].includes(STAGE_OF[s]!));

export interface ItemRow {
  productId: string | null;
  productName: string;
  quantity: number;
  order: { id: string; orderNumber: string; customerName: string; status: string; createdAt: Date | string };
}
export interface ItemOrderRef { id: string; orderNumber: string; customerName: string; status: string; stage: ItemStage; quantity: number; createdAt: string }
export interface ItemSummary {
  key: string;
  productId: string | null;
  productName: string;
  stages: Record<ItemStage, number>;
  /** To receive + in progress + out for delivery. */
  toGive: number;
  orders: ItemOrderRef[];
}

const zero = (): Record<ItemStage, number> => ({ toReceive: 0, inProgress: 0, outForDelivery: 0, done: 0, void: 0 });

/** One row per product (same product in several orders adds up), most still-to-give first, then by name. */
export function summarizeOrderItems(rows: ItemRow[]): { products: ItemSummary[]; totals: Record<ItemStage, number> & { toGive: number } } {
  const byKey = new Map<string, ItemSummary>();
  const totals = { ...zero(), toGive: 0 };
  for (const r of rows) {
    const stage = stageOfStatus(r.order.status);
    if (!stage || !(r.quantity > 0)) continue;
    const key = r.productId ?? `name:${r.productName.trim().toLowerCase()}`;
    let p = byKey.get(key);
    if (!p) { p = { key, productId: r.productId, productName: r.productName, stages: zero(), toGive: 0, orders: [] }; byKey.set(key, p); }
    p.stages[stage] += r.quantity;
    totals[stage] += r.quantity;
    if (stage !== "done" && stage !== "void") { p.toGive += r.quantity; totals.toGive += r.quantity; }
    const createdAt = typeof r.order.createdAt === "string" ? r.order.createdAt : r.order.createdAt.toISOString();
    const same = p.orders.find((o) => o.id === r.order.id);
    if (same) same.quantity += r.quantity;
    else p.orders.push({ id: r.order.id, orderNumber: r.order.orderNumber, customerName: r.order.customerName, status: r.order.status, stage, quantity: r.quantity, createdAt });
  }
  const order = ITEM_STAGES;
  const products = [...byKey.values()].sort((a, b) => b.toGive - a.toGive || a.productName.localeCompare(b.productName));
  // Inside a product: the orders that still need something first (by stage, oldest first), then the rest.
  for (const p of products) p.orders.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage) || (a.createdAt < b.createdAt ? -1 : 1));
  return { products, totals };
}
