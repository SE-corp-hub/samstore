// Owner's data export: every part of the store an analysis needs, as plain tables
// (one row per record, pesos as numbers, Manila dates), for another tool to read.
// Money in the database is centavos; here it is pesos. Loose rice is grams there, kilos here.

import { prisma } from "../persistence/prisma-repositories.js";
import { manilaDate } from "../domain/reports.js";
import { manilaText, type Cell, type Column, type ColumnType, type Table } from "./table-files.js";

export class ExportError extends Error {}

const DAY = 86_400_000;
const MAX_DAYS = 400;
const RESERVED_ONLY = ["RESERVE", "RELEASE_RESERVATION"];

const pesos = (minor: number | null | undefined) => (minor === null || minor === undefined ? null : minor / 100);
const cols = (spec: [string, ColumnType][]): Column[] => spec.map(([header, type]) => ({ header, type }));

/** [from, to) as UTC instants for Manila days `from`..`to` inclusive. Default: the last 30 days. */
export function exportRange(from?: string, to?: string, now = new Date()): { from: Date; to: Date; fromDay: string; toDay: string } {
  const toDay = to || manilaDate(now);
  const fromDay = from || manilaDate(new Date(new Date(`${toDay}T00:00:00+08:00`).getTime() - 29 * DAY));
  for (const d of [fromDay, toDay]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(new Date(`${d}T00:00:00+08:00`).getTime())) throw new ExportError("Dates must look like 2026-10-31");
  }
  const start = new Date(`${fromDay}T00:00:00+08:00`);
  const end = new Date(new Date(`${toDay}T00:00:00+08:00`).getTime() + DAY);
  if (end <= start) throw new ExportError("The start date is after the end date");
  if ((end.getTime() - start.getTime()) / DAY > MAX_DAYS) throw new ExportError(`Pick at most ${MAX_DAYS} days at a time`);
  return { from: start, to: end, fromDay, toDay };
}

interface ProductInfo { name: string; sku: string; variety: string | null; loose: boolean; unit: string }

export class DataExportService {
  async build(storeId: string, fromIn?: string, toIn?: string): Promise<{ tables: Table[]; fromDay: string; toDay: string; storeName: string }> {
    const { from, to, fromDay, toDay } = exportRange(fromIn, toIn);
    const range = { gte: from, lt: to };

    const [store, locations, products, categories, levels, locPrices, orders, movements, transfers, stockIns, resacks, payables, expenses, customers, credit] = await Promise.all([
      prisma.store.findUnique({ where: { id: storeId }, select: { name: true } }),
      prisma.warehouse.findMany({ where: { storeId }, select: { id: true, name: true, code: true, type: true, isActive: true, consignment: true }, orderBy: { name: "asc" } }),
      prisma.product.findMany({ where: { storeId }, orderBy: { name: "asc" }, select: { id: true, sku: true, name: true, variety: true, unit: true, soldByWeight: true, priceMinor: true, costMinor: true, isActive: true, trackStock: true, reviewStatus: true, categoryId: true, createdAt: true } }),
      prisma.category.findMany({ where: { storeId }, select: { id: true, name: true } }),
      prisma.stockLevel.findMany({ where: { storeId, warehouseId: { not: null } }, select: { productId: true, warehouseId: true, quantityOnHand: true, quantityReserved: true, costMinor: true, updatedAt: true } }),
      prisma.locationPrice.findMany({ where: { storeId }, select: { productId: true, warehouseId: true, priceMinor: true, updatedAt: true } }),
      prisma.order.findMany({
        where: { storeId, OR: [{ occurredAt: range }, { occurredAt: null, createdAt: range }] },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, orderNumber: true, status: true, source: true, deliveryType: true, sellingLocationId: true, occurredAt: true, createdAt: true,
          subtotalMinor: true, discountMinor: true, deliveryFeeMinor: true, totalMinor: true, paymentMethod: true, paymentStatus: true,
          customerName: true, customerPhone: true, storeCustomerId: true, agentUserId: true, paperSlipNo: true, encodedLater: true,
          items: { select: { productId: true, productName: true, sku: true, soldBy: true, quantity: true, grams: true, unitPriceMinor: true, lineTotalMinor: true, unitCostMinor: true, priceOverridden: true, priceOverrideReason: true, catalogUnitPriceMinor: true, sourceLocationId: true } },
        },
      }),
      prisma.stockMovement.findMany({ where: { storeId, createdAt: range, type: { notIn: RESERVED_ONLY } }, orderBy: { createdAt: "asc" }, select: { createdAt: true, warehouseId: true, productId: true, type: true, delta: true, balanceAfter: true, documentType: true, note: true } }),
      prisma.stockTransfer.findMany({ where: { storeId, createdAt: range }, orderBy: { createdAt: "asc" }, select: { docNumber: true, kind: true, status: true, createdAt: true, releasedAt: true, receivedAt: true, completedAt: true, fromWarehouseId: true, toWarehouseId: true, productId: true, quantity: true, releasedQty: true, receivedQty: true, deliveredQty: true, returnedQty: true, shortQty: true, customerName: true, reason: true } }),
      prisma.stockIn.findMany({ where: { storeId, createdAt: range }, orderBy: { createdAt: "asc" }, select: { docNumber: true, createdAt: true, locationId: true, supplierName: true, note: true, lines: { select: { productId: true, quantity: true, unitCostMinor: true } } } }),
      prisma.resackJob.findMany({ where: { storeId, startedAt: range }, orderBy: { startedAt: "asc" }, select: { docNumber: true, status: true, startedAt: true, finishedAt: true, locationId: true, inputProductId: true, inputQty: true, inputGrams: true, inputValueMinor: true, outputGrams: true, lossGrams: true, lossValueMinor: true, varietyChange: true, outputs: { select: { productId: true, quantity: true } } } }),
      prisma.storePayableEntry.findMany({ where: { storeId, createdAt: range }, orderBy: { createdAt: "asc" }, select: { docNumber: true, createdAt: true, locationId: true, kind: true, amountMinor: true, productId: true, quantity: true, unitCostMinor: true, sourceLocationId: true, note: true } }),
      prisma.expense.findMany({ where: { storeId, spentAt: range }, orderBy: { spentAt: "asc" }, select: { spentAt: true, category: true, amountMinor: true, note: true } }),
      prisma.storeCustomer.findMany({ where: { storeId }, select: { id: true, createdAt: true, creditApproved: true, creditUnlimited: true, creditLimitMinor: true, creditBalanceMinor: true, tags: true, customer: { select: { name: true, phone: true, address: true } } } }),
      prisma.creditEntry.findMany({ where: { storeId, createdAt: range }, orderBy: { createdAt: "asc" }, select: { createdAt: true, startAt: true, dueAt: true, storeCustomerId: true, type: true, amountMinor: true, note: true, orderId: true } }),
    ]);

    const loc = new Map(locations.map((l) => [l.id, l.code ? `${l.name} (${l.code})` : l.name]));
    const locName = (id: string | null | undefined) => (id ? loc.get(id) ?? id : null);
    const byId = new Map(products.map((p) => [p.id, p]));
    const cat = new Map(categories.map((c) => [c.id, c.name]));
    const prod = new Map<string, ProductInfo>(products.map((p) => [p.id, { name: p.name, sku: p.sku, variety: p.variety, loose: p.soldByWeight, unit: p.soldByWeight ? "kg" : p.unit ?? "sack" }]));
    const pName = (id: string | null | undefined) => (id ? prod.get(id)?.name ?? id : null);
    /** Stock units → shown amount: grams → kilos for loose rice. */
    const qty = (productId: string | null | undefined, q: number | null | undefined) =>
      q === null || q === undefined ? null : productId && prod.get(productId)?.loose ? q / 1000 : q;
    const unitOf = (productId: string | null | undefined) => (productId ? prod.get(productId)?.unit ?? null : null);
    const custName = new Map(customers.map((c) => [c.id, c.customer.name ?? c.customer.phone ?? c.id]));
    const orderNo = new Map(orders.map((o) => [o.id, o.orderNumber]));

    const tables: Table[] = [];

    tables.push({
      name: "Sales lines",
      columns: cols([["Date", "datetime"], ["Day", "date"], ["Order no", "text"], ["Status", "text"], ["Is sale", "text"], ["Source", "text"], ["Location", "text"], ["Customer", "text"], ["Product", "text"], ["SKU", "text"], ["Variety", "text"], ["Sold by", "text"], ["Quantity", "number"], ["Unit", "text"], ["Unit price", "money"], ["Line total", "money"], ["Unit cost", "money"], ["Line cost", "money"], ["Profit", "money"], ["Price changed", "text"], ["Catalog price", "money"], ["Price change reason", "text"], ["Taken from", "text"], ["Payment", "text"]]),
      rows: orders.flatMap((o) => {
        const when = o.occurredAt ?? o.createdAt;
        return o.items.map((i): Cell[] => {
          const loose = i.soldBy === "KILO" || i.soldBy === "PESO";
          const amount = loose ? (i.grams ?? i.quantity) / 1000 : i.quantity;
          const cost = i.unitCostMinor === null ? null : Math.round(i.unitCostMinor * amount);
          return [
            when, when, o.orderNumber, o.status, o.status === "COMPLETED" ? "yes" : "no", o.source, locName(o.sellingLocationId), o.customerName || null,
            i.productName, i.sku, i.productId ? prod.get(i.productId)?.variety ?? null : null, i.soldBy ?? "PIECE", amount, loose ? "kg" : unitOf(i.productId) ?? "pc",
            pesos(i.unitPriceMinor), pesos(i.lineTotalMinor), pesos(i.unitCostMinor), pesos(cost), cost === null ? null : pesos(i.lineTotalMinor - cost),
            i.priceOverridden ? "yes" : "no", pesos(i.catalogUnitPriceMinor), i.priceOverrideReason, locName(i.sourceLocationId), o.paymentMethod,
          ];
        });
      }),
    });

    tables.push({
      name: "Sales",
      columns: cols([["Date", "datetime"], ["Day", "date"], ["Order no", "text"], ["Status", "text"], ["Is sale", "text"], ["Source", "text"], ["Delivery or pickup", "text"], ["Location", "text"], ["Customer", "text"], ["Phone", "text"], ["Items", "number"], ["Subtotal", "money"], ["Discount", "money"], ["Delivery fee", "money"], ["Total", "money"], ["Payment", "text"], ["Payment status", "text"], ["By agent", "text"], ["Paper slip no", "text"], ["Entered later", "text"]]),
      rows: orders.map((o): Cell[] => {
        const when = o.occurredAt ?? o.createdAt;
        return [when, when, o.orderNumber, o.status, o.status === "COMPLETED" ? "yes" : "no", o.source, o.deliveryType, locName(o.sellingLocationId), o.customerName || null, o.customerPhone || null, o.items.length, pesos(o.subtotalMinor), pesos(o.discountMinor), pesos(o.deliveryFeeMinor), pesos(o.totalMinor), o.paymentMethod, o.paymentStatus, o.agentUserId ? "yes" : "no", o.paperSlipNo, o.encodedLater ? "yes" : "no"];
      }),
    });

    tables.push({
      name: "Products",
      columns: cols([["Product", "text"], ["SKU", "text"], ["Variety", "text"], ["Category", "text"], ["Unit", "text"], ["Loose (per kg)", "text"], ["Price", "money"], ["Cost", "money"], ["Margin", "money"], ["Active", "text"], ["Stock tracked", "text"], ["Review", "text"], ["Added", "date"]]),
      rows: products.map((p): Cell[] => [p.name, p.sku, p.variety, p.categoryId ? cat.get(p.categoryId) ?? null : null, prod.get(p.id)!.unit, p.soldByWeight ? "yes" : "no", pesos(p.priceMinor), pesos(p.costMinor), pesos(p.priceMinor - p.costMinor), p.isActive ? "yes" : "no", p.trackStock ? "yes" : "no", p.reviewStatus, p.createdAt]),
    });

    tables.push({
      name: "Prices by location",
      columns: cols([["Location", "text"], ["Product", "text"], ["SKU", "text"], ["Unit", "text"], ["Price", "money"], ["Main price", "money"], ["Last changed", "datetime"]]),
      rows: locPrices.map((lp): Cell[] => {
        const p = byId.get(lp.productId);
        return [locName(lp.warehouseId), pName(lp.productId), prod.get(lp.productId)?.sku ?? null, unitOf(lp.productId), pesos(lp.priceMinor), pesos(p?.priceMinor), lp.updatedAt];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))),
    });

    tables.push({
      name: "Stock now",
      columns: cols([["Location", "text"], ["Product", "text"], ["SKU", "text"], ["Variety", "text"], ["On hand", "number"], ["Held for orders", "number"], ["Unit", "text"], ["Cost each", "money"], ["Stock value", "money"], ["Last changed", "datetime"]]),
      rows: levels.map((s): Cell[] => {
        const p = byId.get(s.productId);
        const costMinor = s.costMinor ?? p?.costMinor ?? null;
        const onHand = qty(s.productId, s.quantityOnHand);
        return [locName(s.warehouseId), pName(s.productId), p?.sku ?? null, p?.variety ?? null, onHand, qty(s.productId, s.quantityReserved), unitOf(s.productId), pesos(costMinor), costMinor === null || onHand === null ? null : Math.round(costMinor * onHand) / 100, s.updatedAt];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))),
    });

    tables.push({
      name: "Stock changes",
      columns: cols([["Date", "datetime"], ["Location", "text"], ["Product", "text"], ["Change", "number"], ["Balance after", "number"], ["Unit", "text"], ["Type", "text"], ["Because of", "text"], ["Note", "text"]]),
      rows: movements.map((m): Cell[] => [m.createdAt, locName(m.warehouseId), pName(m.productId), qty(m.productId, m.delta), qty(m.productId, m.balanceAfter), unitOf(m.productId), m.type, m.documentType, m.note]),
    });

    tables.push({
      name: "Moves",
      columns: cols([["Date", "datetime"], ["Doc no", "text"], ["Kind", "text"], ["Status", "text"], ["From", "text"], ["To", "text"], ["Product", "text"], ["Quantity", "number"], ["Sent", "number"], ["Received", "number"], ["Delivered", "number"], ["Returned", "number"], ["Short", "number"], ["Unit", "text"], ["Customer", "text"], ["Sent at", "datetime"], ["Received at", "datetime"], ["Reason", "text"]]),
      rows: transfers.map((t): Cell[] => [t.createdAt, t.docNumber, t.kind === "ORDER_RELEASE" ? "For a sale" : "Restock", t.status, locName(t.fromWarehouseId), locName(t.toWarehouseId), pName(t.productId), qty(t.productId, t.quantity), qty(t.productId, t.releasedQty), qty(t.productId, t.receivedQty), qty(t.productId, t.deliveredQty), qty(t.productId, t.returnedQty), qty(t.productId, t.shortQty), unitOf(t.productId), t.customerName, t.releasedAt, t.receivedAt ?? t.completedAt, t.reason]),
    });

    tables.push({
      name: "Stock in",
      columns: cols([["Date", "datetime"], ["Doc no", "text"], ["Location", "text"], ["Supplier", "text"], ["Product", "text"], ["Quantity", "number"], ["Unit", "text"], ["Unit cost", "money"], ["Total cost", "money"], ["Note", "text"]]),
      rows: stockIns.flatMap((s) => s.lines.map((l): Cell[] => {
        const amount = qty(l.productId, l.quantity);
        return [s.createdAt, s.docNumber, locName(s.locationId), s.supplierName, pName(l.productId), amount, unitOf(l.productId), pesos(l.unitCostMinor), l.unitCostMinor === null || amount === null ? null : Math.round(l.unitCostMinor * amount) / 100, s.note];
      })),
    });

    tables.push({
      name: "Resack",
      columns: cols([["Started", "datetime"], ["Finished", "datetime"], ["Doc no", "text"], ["Status", "text"], ["Location", "text"], ["From product", "text"], ["From quantity", "number"], ["Input kg", "number"], ["Output kg", "number"], ["Loss kg", "number"], ["Loss %", "number"], ["Input value", "money"], ["Loss value", "money"], ["Changed variety", "text"], ["Made", "text"]]),
      rows: resacks.map((r): Cell[] => [r.startedAt, r.finishedAt, r.docNumber, r.status, locName(r.locationId), pName(r.inputProductId), qty(r.inputProductId, r.inputQty), r.inputGrams / 1000, r.outputGrams === null ? null : r.outputGrams / 1000, r.lossGrams === null ? null : r.lossGrams / 1000, r.lossGrams === null || !r.inputGrams ? null : Math.round((r.lossGrams / r.inputGrams) * 10000) / 100, pesos(r.inputValueMinor), pesos(r.lossValueMinor), r.varietyChange ? "yes" : "no", r.outputs.map((o) => `${qty(o.productId, o.quantity)} ${unitOf(o.productId)} ${pName(o.productId)}`).join("; ") || null]),
    });

    tables.push({
      name: "Store payable",
      columns: cols([["Date", "datetime"], ["Doc no", "text"], ["Store that owes", "text"], ["Kind", "text"], ["Amount", "money"], ["Product", "text"], ["Quantity", "number"], ["Unit", "text"], ["Unit cost", "money"], ["Taken from", "text"], ["Note", "text"]]),
      rows: payables.map((e): Cell[] => [e.createdAt, e.docNumber, locName(e.locationId), e.kind, pesos(e.amountMinor), pName(e.productId), qty(e.productId, e.quantity), unitOf(e.productId), pesos(e.unitCostMinor), locName(e.sourceLocationId), e.note]),
    });

    tables.push({
      name: "Expenses",
      columns: cols([["Date", "datetime"], ["Category", "text"], ["Amount", "money"], ["Note", "text"]]),
      rows: expenses.map((e): Cell[] => [e.spentAt, e.category, pesos(e.amountMinor), e.note]),
    });

    tables.push({
      name: "Customers",
      columns: cols([["Customer", "text"], ["Phone", "text"], ["Address", "text"], ["Credit allowed", "text"], ["Credit limit", "money"], ["Owes now", "money"], ["Tags", "text"], ["Added", "date"]]),
      rows: customers.map((c): Cell[] => [c.customer.name, c.customer.phone, c.customer.address, c.creditApproved || c.creditUnlimited ? "yes" : "no", c.creditUnlimited ? null : pesos(c.creditLimitMinor), pesos(c.creditBalanceMinor), c.tags.join(", ") || null, c.createdAt])
        .sort((a, b) => String(a[0] ?? "").localeCompare(String(b[0] ?? ""))),
    });

    tables.push({
      name: "Credit",
      columns: cols([["Date", "datetime"], ["Customer", "text"], ["Type", "text"], ["Amount", "money"], ["Due", "date"], ["Order no", "text"], ["Note", "text"]]),
      rows: credit.map((c): Cell[] => [c.startAt ?? c.createdAt, custName.get(c.storeCustomerId) ?? null, c.type, pesos(c.amountMinor), c.dueAt, c.orderId ? orderNo.get(c.orderId) ?? null : null, c.note]),
    });

    tables.push({
      name: "Locations",
      columns: cols([["Location", "text"], ["Code", "text"], ["Type", "text"], ["Active", "text"], ["Sells main store's rice", "text"]]),
      rows: locations.map((l): Cell[] => [l.name, l.code, l.type, l.isActive ? "yes" : "no", l.consignment ? "yes" : "no"]),
    });

    const storeName = store?.name ?? "Store";
    const about: Table = {
      name: "About",
      columns: cols([["Item", "text"], ["Value", "text"]]),
      rows: [
        ["Store", storeName],
        ["From", fromDay],
        ["To", toDay],
        ["Made at", manilaText(new Date(), true)],
        ["Time zone", "Philippines (UTC+8)"],
        ["Money", "Pesos (₱)"],
        ["Loose rice", "Kilos (kg)"],
        ["Sales", "Count only rows where Is sale = yes (completed). Other statuses are held, cancelled or not finished."],
        ["Profit", "Line total minus the cost frozen at the time of the sale"],
        ["Store payable", "Plus = that store owes the main store more; minus = paid, reversed, or the main store's share owed back"],
        ["Date range", "Sales, stock changes, moves, stock in, resack, payable, expenses and credit are only for these dates. Products, prices, stock now, customers and locations are as of now."],
        ...tables.map((t): Cell[] => [`Sheet: ${t.name}`, `${t.rows.length} rows`]),
      ],
    };
    return { tables: [about, ...tables], fromDay, toDay, storeName };
  }
}
