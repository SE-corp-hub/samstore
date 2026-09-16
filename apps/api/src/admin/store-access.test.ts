// v6 store access management (Modules A1/A2 + C) — store-wide suspension
// enforcement (status history, login, checkout), per-store data summary, and
// isolation probe. Uses the real Prisma client (repo style); every fixture is
// run-scoped and deleted in the after() hook so the shared DB stays clean.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { StoreAdminService } from "./store-admin.service.js";
import { AuthService } from "../auth/auth.service.js";
import { hashPassword } from "../auth/auth.domain.js";
import { CheckoutService } from "../checkout/checkout.service.js";
import type { AuthRepository, AuthUserRecord } from "../auth/auth.repository.js";
import type { CheckoutRequest } from "@sam-store/contracts";
import {
  InMemoryStoreRepository,
  InMemoryCatalogRepository,
  InMemoryCartRepository,
  InMemoryOrderRepository,
  InMemoryOrderSequenceRepository,
  type StoreRecord,
  type CartRecord,
} from "../persistence/repositories.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { OrderStatus, StoreRole, StoreStatus } from "@prisma/client";

const CONFIG = { jwtSecret: "test-secret-0123456789", jwtExpiresIn: "1h" };
const storesAdmin = new StoreAdminService();

const run = `V6T${Date.now()}${Math.floor(Math.random() * 1000)}`;
const createdStoreIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
const createdProductIds: string[] = [];
const createdStockLevelIds: string[] = [];
const createdCustomerIds: string[] = [];
const createdStoreCustomerIds: string[] = [];

function tag(s: string) {
  return `${run}-${s}`.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

let slugSeq = 0;
async function makeStore(status: StoreStatus = "ACTIVE", name = "store") {
  slugSeq += 1;
  const s = await prisma.store.create({
    data: { name: `${run} ${name}`, slug: tag(`${name}-${slugSeq}`), status },
  });
  createdStoreIds.push(s.id);
  return s;
}

async function makeUser(emailTag: string, role = "STORE_OWNER", memberships: { storeId: string; role: string }[] = []) {
  const email = `${tag(emailTag)}@example.test`;
  const u = await prisma.user.create({
    data: { email, passwordHash: await hashPassword("fixture-password-123"), role },
  });
  createdUserIds.push(u.id);
  for (const m of memberships) {
    await prisma.userStore.create({
      data: { userId: u.id, storeId: m.storeId, role: m.role as StoreRole, status: "ACTIVE" },
    });
  }
  return { id: u.id, email, role };
}

function fakeRepo(user: AuthUserRecord): AuthRepository {
  return {
    async findByEmail(email: string) {
      return user.email?.toLowerCase() === email.toLowerCase() ? user : null;
    },
    async findByIdentifier(identifier: string) {
      const id = (identifier ?? "").trim().toLowerCase();
      if (!id) return null;
      if (user.email?.toLowerCase() === id || user.phone === id) return user;
      return null;
    },
    async createUser() {
      throw new Error("not used in these tests");
    },
  };
}

function authServiceFor(user: AuthUserRecord) {
  return new AuthService(fakeRepo(user), CONFIG);
}

function makeStoreRecord(over: Partial<StoreRecord> = {}): StoreRecord {
  return {
    id: "store-1",
    slug: "sam-store",
    name: "Sam's Store",
    currencyCode: "PHP",
    timezone: "Asia/Manila",
    status: "ACTIVE",
    guestOrderingEnabled: true,
    orderingPaused: false,
    closedStoreMessage: null,
    deliveryFeeMinor: 5000,
    deliveryEnabled: true,
    pickupEnabled: false,
    minOrderAmountMinor: 0,
    ...over,
  };
}

function makeCart(over: Partial<CartRecord> = {}): CartRecord {
  return {
    id: "cart-1",
    storeId: "store-1",
    token: "cart-token-abc123",
    status: "OPEN",
    lines: [{ productId: "prod-1", quantity: 1, unitPriceMinor: 15000 }],
    ...over,
  };
}

function makeRequest(over: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    cartToken: "cart-token-abc123",
    customerName: "Maria Santos",
    customerPhone: "+639171234567",
    deliveryAddressLine1: "123 Rizal Avenue",
    landmark: "Near the church",
    paymentMethod: "cod",
    idempotencyKey: "checkout-abc-123",
    ...over,
  };
}

async function makeOrder(storeId: string, over: { status?: OrderStatus; totalMinor?: number; createdAt?: Date } = {}) {
  const o = await prisma.order.create({
    data: {
      orderNumber: `${tag("order")}-${Math.floor(Math.random() * 1e9)}`.toUpperCase(),
      storeId,
      status: over.status ?? "COMPLETED",
      source: "online",
      currencyCode: "PHP",
      subtotalMinor: over.totalMinor ?? 1000,
      deliveryFeeMinor: 0,
      discountMinor: 0,
      totalMinor: over.totalMinor ?? 1000,
      snapshot: {},
      paymentMethod: "cod",
      paymentStatus: over.status === "COMPLETED" ? "COLLECTED" : "PENDING",
      cartToken: `cart-${Math.floor(Math.random() * 1e12)}`,
      customerName: `${run} Customer`,
      customerPhone: `0917-${run}-summary`,
      deliveryAddressLine1: "123 Rizal Avenue",
      createdAt: over.createdAt ?? new Date(),
    },
  });
  createdOrderIds.push(o.id);
  return o;
}

async function makeProductWithStock(storeId: string, costMinor: number, quantityOnHand: number) {
  const p = await prisma.product.create({
    data: {
      storeId,
      sku: `${tag("prod")}-${Math.floor(Math.random() * 1e6)}`,
      name: `${run} Product`,
      costMinor,
      priceMinor: 2000,
    },
  });
  createdProductIds.push(p.id);
  const sl = await prisma.stockLevel.create({
    data: { storeId, productId: p.id, quantityOnHand, quantityReserved: 0, reorderThreshold: 0 },
  });
  createdStockLevelIds.push(sl.id);
  return { product: p, stockLevel: sl };
}

async function makeStoreCustomer(storeId: string) {
  const c = await prisma.customer.create({
    data: { name: `${run} Customer`, phone: `0917-${run}-cust` },
  });
  createdCustomerIds.push(c.id);
  const sc = await prisma.storeCustomer.create({ data: { storeId, customerId: c.id } });
  createdStoreCustomerIds.push(sc.id);
  return sc;
}

after(async () => {
  if (createdStockLevelIds.length > 0) {
    await prisma.stockLevel.deleteMany({ where: { id: { in: createdStockLevelIds } } });
  }
  if (createdOrderIds.length > 0) {
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (createdProductIds.length > 0) {
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  }
  if (createdStoreCustomerIds.length > 0) {
    await prisma.storeCustomer.deleteMany({ where: { id: { in: createdStoreCustomerIds } } });
  }
  if (createdCustomerIds.length > 0) {
    await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.userStore.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  if (createdStoreIds.length > 0) {
    await prisma.storeStatusHistory.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    // Fix #2: createAtomic writes the outbox event in-transaction and the live
    // worker drains it into a NotificationLog row — clear both before the store.
    await prisma.outboxEvent.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    await prisma.notificationLog.deleteMany({ where: { storeId: { in: createdStoreIds } } });
    await prisma.store.deleteMany({ where: { id: { in: createdStoreIds } } });
  }
  await prisma.$disconnect();
});

// ─────────────────────────────── A1: status + audit history ───────────────────────────────

test("setStatus rejects an unknown status", async () => {
  const store = await makeStore();
  const r = await storesAdmin.setStatus(store.id, null, "HACKED", "x", "admin-1");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "validation");
});

test("setStatus is a no-op for a missing store", async () => {
  const r = await storesAdmin.setStatus("no-such-store", null, "SUSPENDED", "x", "admin-1");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("setStatus suspends a store and writes an audit history row", async () => {
  const store = await makeStore();

  const r = await storesAdmin.setStatus(store.id, null, "SUSPENDED", "late rent payment", "admin-1");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.status, "SUSPENDED");
  assert.equal(r.value.fromStatus, "ACTIVE");
  assert.equal(r.value.changedBy, "admin-1");

  const afterRow = await prisma.store.findUnique({ where: { id: store.id }, select: { status: true } });
  assert.equal(afterRow?.status, "SUSPENDED");

  const history = await prisma.storeStatusHistory.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(history.length, 1);
  assert.equal(history[0]!.toStatus, "SUSPENDED");
  assert.equal(history[0]!.fromStatus, "ACTIVE");
  assert.equal(history[0]!.reason, "late rent payment");
  assert.equal(history[0]!.changedBy, "admin-1");

  // Reinstate: second audit row, fromStatus reflects the previous status.
  const r2 = await storesAdmin.setStatus(store.id, null, "ACTIVE", "rent settled", "admin-1");
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  const history2 = await prisma.storeStatusHistory.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(history2.length, 2);
  assert.equal(history2[1]!.fromStatus, "SUSPENDED");
  assert.equal(history2[1]!.toStatus, "ACTIVE");
});

// ─────────────────────────────── A2: login enforcement ───────────────────────────────

test("login refuses a user whose only store is suspended", async () => {
  const store = await makeStore("SUSPENDED");
  const u = await makeUser("owner-suspended", "STORE_OWNER", [{ storeId: store.id, role: "OWNER" }]);
  const svc = authServiceFor({
    id: u.id,
    email: u.email,
    phone: null,
    phoneVerified: false,
    passwordHash: await hashPassword("fixture-password-123"),
    name: "Suspended Owner",
    role: u.role,
    memberships: [{ storeId: store.id, role: "OWNER" }],
  });
  const r = await svc.login({ email: u.email, password: "fixture-password-123" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.type, "forbidden");
    assert.equal(r.error.message, "Your store is suspended or closed");
  }
});

test("login succeeds while at least one membership store stays active", async () => {
  const suspended = await makeStore("SUSPENDED", "bad");
  const active = await makeStore("ACTIVE", "good");
  const u = await makeUser("owner-multi", "STORE_OWNER", [
    { storeId: suspended.id, role: "OWNER" },
    { storeId: active.id, role: "OWNER" },
  ]);
  const svc = authServiceFor({
    id: u.id,
    email: u.email,
    phone: null,
    phoneVerified: false,
    passwordHash: await hashPassword("fixture-password-123"),
    name: "Multi Owner",
    role: u.role,
    memberships: [
      { storeId: suspended.id, role: "OWNER" },
      { storeId: active.id, role: "OWNER" },
    ],
  });
  const r = await svc.login({ email: u.email, password: "fixture-password-123" });
  assert.equal(r.ok, true);
});

test("login bypasses the restriction for PLATFORM_ADMIN", async () => {
  const store = await makeStore("CLOSED");
  const u = await makeUser("platform-admin", "PLATFORM_ADMIN", [{ storeId: store.id, role: "OWNER" }]);
  const svc = authServiceFor({
    id: u.id,
    email: u.email,
    phone: null,
    phoneVerified: false,
    passwordHash: await hashPassword("fixture-password-123"),
    name: "Platform Admin",
    role: u.role,
    memberships: [{ storeId: store.id, role: "OWNER" }],
  });
  const r = await svc.login({ email: u.email, password: "fixture-password-123" });
  assert.equal(r.ok, true);
});

// ─────────────────────────────── A2: checkout enforcement ───────────────────────────────

test("checkout returns a conflict when the store is suspended", async () => {
  const stores = new InMemoryStoreRepository();
  const catalog = new InMemoryCatalogRepository();
  const carts = new InMemoryCartRepository();
  const orders = new InMemoryOrderRepository();
  const sequences = new InMemoryOrderSequenceRepository();
  stores.seed(makeStoreRecord({ status: "SUSPENDED" }));
  carts.seed(makeCart());
  const svc = new CheckoutService(stores, catalog, carts, orders, sequences, "test-claim-secret-0123456789");

  const r = await svc.checkout(makeRequest());
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.type, "conflict");
    assert.equal(r.error.message, "This store is not accepting orders right now");
  }
  assert.equal(orders.exportedForTests().orders.length, 0, "no order is created for a suspended store");
});

// ─────────────────────────────── C: data summary ───────────────────────────────

test("dataSummary aggregates orders, sales, inventory, customers, members, last activity", async () => {
  const store = await makeStore();
  await makeProductWithStock(store.id, 500, 3); // ₱15.00 × 3
  await makeProductWithStock(store.id, 1000, 2); // ₱10.00 × 2
  await makeOrder(store.id, { status: "COMPLETED", totalMinor: 1200, createdAt: new Date("2026-08-01T00:00:00Z") });
  await makeOrder(store.id, { status: "DELIVERED", totalMinor: 800, createdAt: new Date("2026-08-05T00:00:00Z") });
  await makeOrder(store.id, { status: "CANCELLED", totalMinor: 999999, createdAt: new Date("2026-08-02T00:00:00Z") });
  await makeStoreCustomer(store.id);
  await makeUser("summary-manager", "MANAGER", [{ storeId: store.id, role: "MANAGER" }]);

  const s = await storesAdmin.getDataSummary(store.id);
  assert.equal(s.orders, 3);
  assert.equal(s.salesTotalMinor, 2000, "COMPLETED + DELIVERED only");
  assert.equal(s.inventoryValueMinor, 3500, "sum(quantityOnHand × costMinor)");
  assert.equal(s.customers, 1);
  assert.equal(s.members, 1);
  assert.equal(s.lastActivityAt?.toISOString(), "2026-08-05T00:00:00.000Z");
});

test("dataSummary handles an empty store", async () => {
  const store = await makeStore();
  const s = await storesAdmin.getDataSummary(store.id);
  assert.equal(s.orders, 0);
  assert.equal(s.salesTotalMinor, 0);
  assert.equal(s.inventoryValueMinor, 0);
  assert.equal(s.customers, 0);
  assert.equal(s.members, 0);
  assert.equal(s.lastActivityAt, null);
});

// ─────────────────────────────── C: isolation probe ───────────────────────────────

test("isolationProbe reports a non-200 response as isolated", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthorized");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await storesAdmin.isolationProbe("store-b", "bad-token", `http://127.0.0.1:${port}`);
    assert.equal(result.isolated, true);
    assert.equal(result.status, 401);
  } finally {
    server.close();
  }
});

test("isolationProbe reports a 200 response as not isolated", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await storesAdmin.isolationProbe("store-b", "good-token", `http://127.0.0.1:${port}`);
    assert.equal(result.isolated, false);
    assert.equal(result.status, 200);
  } finally {
    server.close();
  }
});