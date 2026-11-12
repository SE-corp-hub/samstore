// Per-store build, step 6 — the wall, against the real DB.
//   * who is behind the wall: a store login (not owner, not manager) with a home store;
//   * a store login is refused the whole-business screens and another store's orders;
//   * the order lists, held sales, payment review, Home numbers and a customer's sales show the
//     login's own store only; the main store also owns the old orders that name no store;
//   * every route that names an order in its address is covered by a rule (so a new one cannot
//     slip past the wall).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../persistence/prisma-repositories.js";
import { PosService } from "../pos/pos.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { AnalyticsService } from "../admin/analytics.service.js";
import { checkWall, orderInsideWall, orderWall, runWithWall, wallAt, wallFor, WALL_RULES, type Wall } from "./wall.js";

const run = `WAL${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let n = 0;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.order.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function fixture() {
  const store = await prisma.store.create({ data: { slug: `${run}`.toLowerCase(), name: "Wall" } });
  storeIds.push(store.id);
  const main = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const bt = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bahay Tindahan", code: "S2", type: "STORE", consignment: true } });
  const lipa = await prisma.warehouse.create({ data: { storeId: store.id, name: "Lipa", code: "S3", type: "STORE", consignment: true } });
  const person = async (name: string, role: "OWNER" | "MANAGER" | "STAFF", homeLocationId: string | null) => {
    const u = await prisma.user.create({ data: { email: `${run}-${name}@wal.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId } });
    return u.id;
  };
  const order = async (locationId: string | null, status: "COMPLETED" | "ON_HOLD" = "COMPLETED", extra: Record<string, unknown> = {}) => {
    n += 1;
    return (await prisma.order.create({
      data: {
        orderNumber: `${run}-${n}`, storeId: store.id, status, source: "pos", currencyCode: "PHP", subtotalMinor: 10_000, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: 10_000,
        snapshot: {}, paymentMethod: "cash", paymentStatus: "COLLECTED", cartToken: `cart-${run}-${n}`, customerName: "Walk-in", customerPhone: "", deliveryAddressLine1: "", sellingLocationId: locationId, ...extra,
      },
    })).id;
  };
  return {
    storeId: store.id, main: main.id, bt: bt.id, lipa: lipa.id,
    owner: await person("owner", "OWNER", null), manager: await person("manager", "MANAGER", bt.id),
    btStaff: await person("bt", "STAFF", bt.id), mainStaff: await person("main", "STAFF", main.id), floater: await person("floater", "STAFF", null),
    atMain: await order(main.id), noStore: await order(null), atBt: await order(bt.id), atLipa: await order(lipa.id),
    heldBt: await order(bt.id, "ON_HOLD"), heldLipa: await order(lipa.id, "ON_HOLD"),
  };
}

test("the wall: who is behind it, what it refuses, and what the lists show", async () => {
  const fx = await fixture();

  // Who is behind the wall.
  assert.equal(await wallFor(fx.storeId, fx.owner, "OWNER"), null, "the owner sees everything");
  assert.equal(await wallFor(fx.storeId, fx.manager, "MANAGER"), null, "a manager sees everything, even with a home store");
  assert.equal(await wallFor(fx.storeId, fx.floater, "STAFF"), null, "a login with no home store is not walled (as before)");
  const bt = await wallFor(fx.storeId, fx.btStaff, "STAFF");
  const main = await wallFor(fx.storeId, fx.mainStaff, "STAFF");
  assert.equal(bt?.locationId, fx.bt);
  assert.equal(main?.locationId, fx.main);

  // Orders: its own store's only; the main store also owns the orders that name no store.
  const inside = async (w: Wall | null, id: string) => orderInsideWall(fx.storeId, id, w);
  assert.deepEqual([await inside(bt, fx.atBt), await inside(bt, fx.atLipa), await inside(bt, fx.atMain), await inside(bt, fx.noStore)], [true, false, false, false]);
  assert.deepEqual([await inside(main, fx.atMain), await inside(main, fx.noStore), await inside(main, fx.atBt)], [true, true, false]);
  assert.equal(await inside(null, fx.atLipa), true, "no wall: every order");

  // The rule table, as the interceptor asks it.
  const ask = (w: Wall | null, method: string, path: string, id?: string) => checkWall(w, fx.storeId, method, path, { id });
  for (const [method, path] of [
    ["GET", "/admin/reports/profit"], ["GET", "/admin/reports/sales-by-payment"], ["GET", "/admin/analytics/summary"], ["GET", "/admin/purchases"], ["POST", "/admin/purchases"],
    ["GET", "/admin/suppliers"], ["GET", "/admin/purchase-orders"], ["GET", "/admin/purchase-orders/owed"], ["GET", "/admin/customers/export.csv"], ["GET", "/admin/crm/customers"],
    ["GET", "/admin/export"], ["GET", "/admin/rice/weekly"], ["POST", "/admin/products"], ["PATCH", "/admin/products/:id"], ["DELETE", "/admin/products/:id"], ["PUT", "/admin/products/:id/photo"],
  ] as const) {
    const v = await ask(bt, method, path);
    assert.deepEqual([v.ok, v.ok ? 0 : v.status], [false, 403], `${method} ${path} is for the owner`);
    assert.equal((await ask(null, method, path)).ok, true, `${method} ${path} stays open to the owner`);
  }
  for (const [method, path] of [["GET", "/admin/products"], ["GET", "/admin/products/categories"], ["GET", "/admin/orders"], ["GET", "/admin/customers"], ["GET", "/admin/customers/:id"], ["GET", "/admin/rice/daily"], ["GET", "/admin/analytics/daily"], ["GET", "/admin/expenses"]] as const) {
    assert.equal((await ask(bt, method, path)).ok, true, `${method} ${path} stays open to a store login`);
  }
  for (const path of ["/admin/orders/:id", "/admin/orders/:id/status", "/admin/orders/:id/payments", "/admin/orders/:id/void", "/admin/orders/:id/refund", "/admin/orders/:id/receipt", "/admin/pos/holds/:id/complete", "/admin/pos/preorders/:id/finalize", "/admin/pos/sells/:id/for-delivery"]) {
    const other = await ask(bt, "GET", path, fx.atLipa);
    assert.deepEqual([other.ok, other.ok ? 0 : other.status], [false, 404], `${path}: another store's order is not found`);
    assert.equal((await ask(bt, "GET", path, fx.atBt)).ok, true, `${path}: its own order is fine`);
    assert.equal((await ask(null, "GET", path, fx.atLipa)).ok, true, `${path}: the owner opens any order`);
  }

  // The lists, read behind a wall.
  const ids = async () => (await prisma.order.findMany({ where: { storeId: fx.storeId, AND: [orderWall()] }, select: { id: true } })).map((o) => o.id).sort();
  assert.deepEqual(await runWithWall(bt, ids), [fx.atBt, fx.heldBt].sort());
  assert.deepEqual(await runWithWall(main, ids), [fx.atMain, fx.noStore].sort());
  assert.equal((await ids()).length, 6, "outside a request there is no wall");
  assert.equal((await runWithWall(wallAt(fx.lipa, fx.main), ids)).length, 2);

  const pos = new PosService(new LoyaltyService());
  assert.deepEqual((await runWithWall(bt, () => pos.listHolds(fx.storeId))).map((h) => h.id), [fx.heldBt], "held sales: its own store's");
  assert.equal((await pos.listHolds(fx.storeId)).length, 2);

  const analytics = new AnalyticsService();
  const count = (rows: { count: number }[]) => rows.reduce((a, r) => a + r.count, 0);
  assert.equal(count(await runWithWall(bt, () => analytics.statusBreakdown(fx.storeId)) as { count: number }[]), 2, "Home numbers: its own store's orders");
  assert.equal(count(await analytics.statusBreakdown(fx.storeId) as { count: number }[]), 6);
});

test("every route that names an order in its address is covered by the wall", () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith(".controller.ts")) files.push(p); } };
  walk(join(import.meta.dirname, ".."));
  const routes: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const prefix = /@Controller\(\s*"([^"]*)"\s*\)/.exec(src)?.[1] ?? "";
    if (!prefix.startsWith("admin")) continue;
    for (const m of src.matchAll(/@(?:Get|Post|Patch|Put|Delete)\(\s*"([^"]*)"\s*\)/g)) routes.push(`/${prefix}/${m[1]}`.replace(/\/+/g, "/"));
  }
  assert.ok(routes.length > 100, "the controllers were read");
  const orderRoutes = routes.filter((r) => /\/(orders|holds|preorders|sells)\/:/.test(r) && !/\/(agent-orders|purchase-orders|erp)\//.test(r)); // the ledger routes are owner and manager only
  assert.ok(orderRoutes.length >= 15, `order routes found: ${orderRoutes.length}`);
  const own = WALL_RULES.filter((r) => r.kind === "own-order");
  for (const r of orderRoutes) assert.ok(own.some((rule) => rule.path.test(r)), `${r} names an order but no wall rule covers it (use ":id" and add it to WALL_RULES)`);
  // And every rule still points at a real route.
  for (const rule of WALL_RULES) assert.ok(routes.some((r) => rule.path.test(r)), `wall rule ${rule.path} matches no route`);
});
