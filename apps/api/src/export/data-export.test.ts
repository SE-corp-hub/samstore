// Data export, against the real DB: the numbers come out in pesos and kilos, only this store's
// rows and dates are in it, and the Excel/CSV files are real zips with one part per sheet.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { prisma } from "../persistence/prisma-repositories.js";
import { DataExportService, exportRange, ExportError } from "./data-export.service.js";
import { csvZip, toCsv, toJson, toXlsx, type Table } from "./table-files.js";

const run = `EXP${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const customerIds: string[] = [];

after(async () => {
  const where = { storeId: { in: storeIds } };
  await prisma.creditEntry.deleteMany({ where });
  await prisma.orderItem.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.storePayableEntry.deleteMany({ where });
  await prisma.expense.deleteMany({ where });
  await prisma.storeCustomer.deleteMany({ where });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.stockLevel.deleteMany({ where });
  await prisma.locationPrice.deleteMany({ where });
  await prisma.product.deleteMany({ where });
  await prisma.warehouse.deleteMany({ where });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.$disconnect();
});

/** The files inside a zip, unpacked (enough of the format for the zips we write). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const name = buf.toString("utf8", at + 30, at + 30 + nameLen);
    const start = at + 30 + nameLen;
    out.set(name, inflateRawSync(buf.subarray(start, start + size)).toString("utf8"));
    at = start + size;
  }
  return out;
}

async function seed(label: string) {
  const store = await prisma.store.create({ data: { slug: `${run}-${label}`.toLowerCase(), name: `Export ${label}` } });
  storeIds.push(store.id);
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE", consignment: true } });
  const sack = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${label}-J25`, name: "Jasmine 25 kg", variety: "Jasmine", priceMinor: 135_000, costMinor: 115_000 } });
  const loose = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${label}-JK`, name: "Jasmine (per kilo)", variety: "Jasmine", priceMinor: 5_600, costMinor: 4_600, soldByWeight: true } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: sack.id, warehouseId: s1.id, quantityOnHand: 12 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: loose.id, warehouseId: s2.id, quantityOnHand: 7_500 } });
  await prisma.locationPrice.create({ data: { storeId: store.id, warehouseId: s2.id, productId: sack.id, priceMinor: 137_000 } });
  const cust = await prisma.customer.create({ data: { name: `Aling Nena ${label}`, phone: "09170000000" } });
  customerIds.push(cust.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId: store.id, customerId: cust.id, creditApproved: true, creditBalanceMinor: 270_000 } });
  return { store, s1, s2, sack, loose, sc };
}

const orderBase = (storeId: string, n: string) => ({
  storeId, orderNumber: n, currencyCode: "PHP", snapshot: {}, cartToken: n, customerName: "Aling Nena", customerPhone: "09170000000", deliveryAddressLine1: "-",
});

test("export: sales lines in pesos and kilos with profit, only this store and these dates", async () => {
  const a = await seed("a");
  const b = await seed("b"); // another store: must never appear
  const today = new Date();
  const order = await prisma.order.create({
    data: {
      ...orderBase(a.store.id, `${run}-1`), status: "COMPLETED", source: "pos", sellingLocationId: a.s1.id, storeCustomerId: a.sc.id,
      subtotalMinor: 277_800, totalMinor: 277_800, paymentMethod: "credit",
      items: { create: [
        { productId: a.sack.id, productName: "Jasmine 25 kg", sku: a.sack.sku, unitPriceMinor: 135_000, quantity: 2, lineTotalMinor: 270_000, unitCostMinor: 115_000 },
        { productId: a.loose.id, productName: "Jasmine (per kilo)", sku: a.loose.sku, soldBy: "KILO", grams: 1_500, unitPriceMinor: 5_200, quantity: 1_500, lineTotalMinor: 7_800, unitCostMinor: 4_600 },
      ] },
    },
  });
  // A paper slip from 60 days ago: outside the default 30 days.
  await prisma.order.create({ data: { ...orderBase(a.store.id, `${run}-old`), status: "COMPLETED", occurredAt: new Date(today.getTime() - 60 * 86_400_000), subtotalMinor: 100, totalMinor: 100 } });
  await prisma.order.create({ data: { ...orderBase(b.store.id, `${run}-other`), status: "COMPLETED", subtotalMinor: 100, totalMinor: 100 } });
  await prisma.creditEntry.create({ data: { storeId: a.store.id, storeCustomerId: a.sc.id, orderId: order.id, type: "purchase", amountMinor: 270_000 } });
  await prisma.expense.create({ data: { storeId: a.store.id, category: "transport", amountMinor: 50_000, note: 'Jeep, "Store 2"' } });
  await prisma.storePayableEntry.create({ data: { storeId: a.store.id, docNumber: `${run}-SP1`, locationId: a.s2.id, kind: "CHARGE", amountMinor: 115_000, productId: a.sack.id, quantity: 1, unitCostMinor: 115_000, createdById: "x" } });

  const { tables, storeName } = await new DataExportService().build(a.store.id);
  assert.equal(storeName, "Export a");
  const t = (name: string) => tables.find((x) => x.name === name)!;
  const json = toJson(tables);

  const lines = json["sales-lines"]!;
  assert.equal(lines.length, 2, "only this store's sales in the date range");
  const sackLine = lines.find((l) => l.SKU === a.sack.sku)!;
  assert.deepEqual([sackLine.Quantity, sackLine.Unit, sackLine["Unit price"], sackLine["Line total"], sackLine["Line cost"], sackLine.Profit, sackLine.Location, sackLine["Is sale"]],
    [2, "sack", 1350, 2700, 2300, 400, "Store 1 (S1)", "yes"]);
  const looseLine = lines.find((l) => l.SKU === a.loose.sku)!;
  assert.deepEqual([looseLine.Quantity, looseLine.Unit, looseLine["Line total"], looseLine["Line cost"], looseLine.Profit], [1.5, "kg", 78, 69, 9]);

  assert.equal(json["sales"]!.length, 1);
  assert.equal(json["sales"]![0]!.Total, 2778);
  const stock = json["stock-now"]!;
  assert.deepEqual(stock.map((s) => [s.Location, s["On hand"], s.Unit, s["Stock value"]]), [["Store 1 (S1)", 12, "sack", 13800], ["Store 2 (S2)", 7.5, "kg", 345]]);
  assert.equal(json["prices-by-location"]![0]!.Price, 1370);
  assert.equal(json["store-payable"]![0]!["Store that owes"], "Store 2 (S2)");
  assert.equal(json["customers"]![0]!["Owes now"], 2700);
  assert.equal(json["credit"]![0]!["Order no"], `${run}-1`);
  assert.equal(t("Expenses").rows.length, 1);
  assert.ok(!JSON.stringify(json).includes(`${run}-other`), "another store's sale never leaks in");

  // Asking for the old day finds the paper slip by when it really happened.
  const old = manila(new Date(today.getTime() - 60 * 86_400_000));
  const back = await new DataExportService().build(a.store.id, old, old);
  assert.deepEqual(toJson(back.tables)["sales"]!.map((s) => s["Order no"]), [`${run}-old`]);

  // The workbook: a zip with one worksheet per table, frozen header, real numbers.
  const files = unzip(toXlsx(tables));
  assert.ok(files.has("xl/workbook.xml") && files.has("xl/styles.xml") && files.has("[Content_Types].xml"));
  assert.equal([...files.keys()].filter((k) => k.startsWith("xl/worksheets/")).length, tables.length);
  const wb = files.get("xl/workbook.xml")!;
  assert.match(wb, /<sheet name="About"/);
  assert.match(wb, /<sheet name="Sales lines"/);
  const salesSheet = files.get(`xl/worksheets/sheet${tables.findIndex((x) => x.name === "Sales lines") + 1}.xml`)!;
  assert.match(salesSheet, /state="frozen"/);
  assert.match(salesSheet, /<c r="P2" s="4"><v>(2700|78)<\/v><\/c>/);

  const csv = unzip(csvZip(tables));
  assert.ok(csv.get("expenses.csv")!.includes('"Jeep, ""Store 2"""'), "commas and quotes are escaped");
});

const manila = (d: Date) => new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

test("exportRange: default 30 days, inclusive end day, bad input refused", () => {
  const now = new Date("2026-10-31T03:00:00Z"); // 11 AM Manila
  const r = exportRange(undefined, undefined, now);
  assert.equal(r.fromDay, "2026-10-02");
  assert.equal(r.toDay, "2026-10-31");
  assert.equal(r.from.toISOString(), "2026-10-01T16:00:00.000Z");
  assert.equal(r.to.toISOString(), "2026-10-31T16:00:00.000Z");
  assert.throws(() => exportRange("2026-10-31", "2026-10-01"), ExportError);
  assert.throws(() => exportRange("31/10/2026", "2026-10-31"), ExportError);
  assert.throws(() => exportRange("2024-01-01", "2026-10-31"), ExportError);
});

test("table files: CSV keeps dates in Manila time and money as plain numbers", () => {
  const t: Table = { name: "X", columns: [{ header: "When", type: "datetime" }, { header: "Day", type: "date" }, { header: "₱", type: "money" }, { header: "Note", type: "text" }], rows: [[new Date("2026-10-30T17:30:00Z"), new Date("2026-10-30T17:30:00Z"), 1234.5, null]] };
  assert.equal(toCsv(t), "﻿When,Day,₱,Note\r\n2026-10-31 01:30,2026-10-31,1234.5,\r\n");
  const xml = unzip(toXlsx([t])).get("xl/worksheets/sheet1.xml")!;
  // 2026-10-31 01:30 Manila = Excel day 46326 + 1.5 h; the date column drops the time.
  assert.match(xml, /<c r="A2" s="2"><v>46326\.0625<\/v><\/c><c r="B2" s="3"><v>46326<\/v><\/c>/);
});
