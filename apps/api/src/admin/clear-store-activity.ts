// Soft launch: clear a store's TEST activity (sales, orders, money, stock) but keep its setup
// (locations, products, prices, customers, people, settings). Used once, before real selling
// starts, by scripts/clear-test-data.ts. DRY-RUN BY DEFAULT: the caller must pass apply: true.
//
// Every table that carries a storeId must be named in CLEAR_TABLES or KEEP_TABLES. A new table
// that is in neither list stops the tool, so a later schema change can never be cleared (or
// kept) by accident.

import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";

/** Activity: removed for the store. */
export const CLEAR_TABLES = [
  "ApprovalRequest", "Cart", "CartItem", "CashHandover", "CashMovement", "CourierRemittance",
  "CreditEntry", "DailyClose", "DeliveryBooking", "DeliveryEvent", "Expense", "FlowDraft",
  "JournalEntry", "JournalEntryLine", "LoyaltyEntry", "Order", "OrderClaimToken", "OrderItem",
  "OrderStatusHistory", "OutboxEvent", "Payment", "PaymentStatusHistory", "Purchase", "PurchaseItem",
  "PurchaseOrder", "PurchaseOrderLine", "RegisterSession", "ResackJob", "ResackOutput", "Signature",
  "StockConversion", "StockCount", "StockCountLine", "StockIn", "StockInLine", "StockLevel",
  "StockMovement", "StockReturn", "StockTransfer", "StockWriteOff", "StorePayableEntry",
  "StoreSalesReport", "SupplierPayment", "VoucherRedemption",
] as const;

/**
 * Setup and history: kept. AuditLog and the other history tables stay so "who did what" is never
 * lost. StoreCounter stays so order and slip numbers keep counting up (no number is used twice).
 */
export const KEEP_TABLES = [
  "Account", "AuditLog", "Campaign", "CampaignRecipient", "CannedReply", "Category", "Conversation",
  "CustomerPrice", "DeliveryZone", "Kargador", "LocationPrice", "Message", "MessengerPage",
  "MessengerUser", "NotificationLog", "PasswordResetHistory", "PaymentMethod", "PriceHistory",
  "Product", "ProductAddon", "ProductAddonOption", "ProductImage", "ProductPhoto", "ProductRelation",
  "ProductVariant", "PublicStoreLink", "RackSack", "Register", "RolePermission", "SecurityIncident", "SmsMessage",
  "StoreCounter", "StoreCustomer", "StoreCustomerAddress", "StoreMembership", "StoreSettings",
  "StoreStatusHistory", "Supplier", "UserStore", "Voucher", "Warehouse",
] as const;

type Model = (typeof Prisma.dmmf.datamodel.models)[number];
const models = (): readonly Model[] => Prisma.dmmf.datamodel.models;
const tableOf = (m: Model) => m.dbName ?? m.name;

/** Store tables named in neither list (must be empty before the tool runs). */
export function unclassifiedTables(): string[] {
  const named = new Set<string>([...CLEAR_TABLES, ...KEEP_TABLES]);
  return models().filter((m) => m.fields.some((f) => f.name === "storeId") && !named.has(m.name)).map((m) => m.name);
}

/** CLEAR_TABLES ordered so a row is always removed before the rows it points at. */
export function clearOrder(): string[] {
  const clear = new Set<string>(CLEAR_TABLES);
  const pointsAt = new Map<string, Set<string>>();
  for (const m of models()) {
    if (!clear.has(m.name)) continue;
    const deps = new Set<string>();
    for (const f of m.fields) if (f.kind === "object" && f.relationFromFields?.length && clear.has(f.type) && f.type !== m.name) deps.add(f.type);
    pointsAt.set(m.name, deps);
  }
  // A table can go once nothing left still points at it.
  const order: string[] = [];
  const left = new Set(clear);
  while (left.size) {
    const ready = [...left].filter((t) => ![...left].some((o) => o !== t && pointsAt.get(o)?.has(t)));
    if (!ready.length) throw new Error(`clear-store-activity: circular links between ${[...left].join(", ")}`);
    for (const t of ready.sort()) { order.push(t); left.delete(t); }
  }
  return order;
}

/** Every activity row of the store, table by table, for a safety copy before clearing. */
export async function exportStoreActivity(storeId: string): Promise<Record<string, unknown[]>> {
  const byName = new Map(models().map((m) => [m.name, m] as const));
  const out: Record<string, unknown[]> = {};
  for (const t of clearOrder()) {
    out[t] = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${tableOf(byName.get(t)!)}" WHERE "storeId" = $1`, storeId);
  }
  return out;
}

export type ClearReport = { applied: boolean; rows: Record<string, number>; total: number };

/** Count (and with apply: remove) the store's activity. Setup rows are never touched. */
export async function clearStoreActivity(storeId: string, opts: { apply?: boolean } = {}): Promise<ClearReport> {
  const missing = unclassifiedTables();
  if (missing.length) throw new Error(`clear-store-activity: decide CLEAR or KEEP for ${missing.join(", ")}`);
  const byName = new Map(models().map((m) => [m.name, m] as const));
  const order = clearOrder();

  const run = async (tx: Prisma.TransactionClient): Promise<ClearReport> => {
    const rows: Record<string, number> = {};
    for (const t of order) {
      const r = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${tableOf(byName.get(t)!)}" WHERE "storeId" = $1`, storeId);
      rows[t] = Number(r[0]?.n ?? 0);
    }
    if (opts.apply) {
      // Product.stockLevelId is the one kept column that points into a cleared table.
      await tx.$executeRawUnsafe(`UPDATE "Product" SET "stockLevelId" = NULL WHERE "storeId" = $1 AND "stockLevelId" IS NOT NULL`, storeId);
      for (const t of order) await tx.$executeRawUnsafe(`DELETE FROM "${tableOf(byName.get(t)!)}" WHERE "storeId" = $1`, storeId);
      // Totals kept on setup rows that came from the cleared activity.
      await tx.$executeRawUnsafe(`UPDATE "StoreCustomer" SET "creditBalanceMinor" = 0, "loyaltyBalancePoints" = 0 WHERE "storeId" = $1`, storeId);
      await tx.$executeRawUnsafe(`UPDATE "ProductVariant" SET "quantityOnHand" = 0, "quantityReserved" = 0 WHERE "storeId" = $1`, storeId);
      await tx.$executeRawUnsafe(`UPDATE "Voucher" SET "usedCount" = 0 WHERE "storeId" = $1`, storeId);
    }
    return { applied: !!opts.apply, rows, total: Object.values(rows).reduce((a, b) => a + b, 0) };
  };

  // One transaction: either everything is cleared or nothing is.
  return prisma.$transaction(run, { timeout: 300_000, maxWait: 60_000 });
}
