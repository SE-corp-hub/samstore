// N2 live probe — drives the REAL API over HTTP: payment methods → partial payment →
// cash+utang split (credit ledger) → change → idempotent replay → overpay guard →
// derived settlement → cross-tenant denial. Cleanup ALWAYS runs (finally).
import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";

const API = "http://localhost:4100";

async function call(path: string, opts: { method?: string; token?: string; storeId?: string; body?: unknown } = {}) {
  const res = await fetch(API + path, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.storeId ? { "X-Store-Id": opts.storeId } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

async function cleanup(storeId: string, productId: string) {
  await prisma.notificationLog.deleteMany({ where: { storeId } });
  await prisma.outboxEvent.deleteMany({ where: { storeId } });
  await prisma.cashMovement.deleteMany({ where: { storeId } });
  await prisma.creditEntry.deleteMany({ where: { storeId } });
  await prisma.payment.deleteMany({ where: { storeId } });
  await prisma.paymentMethod.deleteMany({ where: { storeId } });
  await prisma.orderClaimToken.deleteMany({ where: { storeId } });
  await prisma.orderStatusHistory.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { storeId } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.registerSession.deleteMany({ where: { storeId } });
  await prisma.register.deleteMany({ where: { storeId } });
  await prisma.stockMovement.deleteMany({ where: { storeId } });
  await prisma.stockLevel.deleteMany({ where: { productId } });
  await prisma.storeCustomer.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.storeMembership.deleteMany({ where: { storeId } });
  await prisma.userStore.deleteMany({ where: { storeId } });
  await prisma.storeSettings.deleteMany({ where: { storeId } });
  await prisma.storeCounter.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
  console.log("\nprobe fixture cleaned up");
}

async function probe(storeId: string, productId: string, customerId: string) {
  const admin = await prisma.user.findFirst({ where: { email: "admin@samstore.test" }, select: { id: true, email: true, name: true } });
  await prisma.userStore.create({ data: { userId: admin!.id, storeId, role: "OWNER", status: "ACTIVE" } });
  await prisma.storeMembership.create({
    data: { storeId, platformUserId: admin!.id, email: admin!.email, displayName: admin!.name ?? "Probe Admin", role: "OWNER", status: "ACTIVE", acceptedAt: new Date() },
  });

  const login = await call("/auth/login", { method: "POST", body: { email: "admin@samstore.test", password: "admin-pass-123" } });
  const token = login.body?.token as string;
  console.log(`login: HTTP ${login.status} · token ${token ? "ok" : "MISSING"}`);

  console.log("\n1) payment methods (seeded on first use)");
  const methods = await call("/admin/payment-methods", { token, storeId });
  console.log(`   GET /admin/payment-methods → HTTP ${methods.status} · ${(methods.body?.methods ?? []).map((m: any) => m.code).join(", ")}`);

  console.log("\n2) open a shift so counter tenders land in the drawer");
  const open = await call("/admin/registers/open", { method: "POST", token, storeId, body: { openingFloatMinor: 100000 } });
  const sessionId = open.body?.session?.sessionId as string;
  console.log(`   POST /admin/registers/open → HTTP ${open.status} · session ${sessionId ? "ok" : "MISSING"}`);

  console.log("\n3) one POS sale → order to split");
  const sale = await call("/admin/pos/sell", { method: "POST", token, storeId, body: { items: [{ productId, quantity: 1 }], paymentMethod: "cash", tenderedMinor: 40000 } });
  const orderId = sale.body?.orderId as string;
  // The POS sale already has an order; a SECOND order is created for the split flow so
  // the split command is the only writer of its payments.
  const order2 = await prisma.order.create({
    data: {
      id: `${orderId}-split`, orderNumber: `${sale.body?.orderNumber ?? "N2"}-SPLIT`, storeId,
      status: "COMPLETED", currencyCode: "PHP", deliveryType: "pickup", fulfillmentType: "PICKUP",
      subtotalMinor: 100000, totalMinor: 100000, snapshot: {}, paymentMethod: "cod", paymentStatus: "PENDING",
      idempotencyKey: `n2probe-${Date.now()}`, cartToken: `n2probe-${Date.now()}`, deliveryAddressLine1: "",
      customerName: "N2 Probe Buyer", customerPhone: "+639****0004", storeCustomerId: customerId,
    },
  });
  console.log(`   POS sale → HTTP ${sale.status} · order ${orderId ? "ok" : "MISSING"} · split target ${order2.id.slice(0, 12)}…`);

  console.log("\n4) partial payment ₱400 of ₱1000");
  const partial = await call(`/admin/orders/${order2.id}/payments`, {
    method: "POST", token, storeId,
    body: { idempotencyKey: `n2probe-partial-${order2.id}`, tenders: [{ methodCode: "cash", amountMinor: 40000 }] },
  });
  console.log(`   POST payments → HTTP ${partial.status} · settlement=${partial.body?.settlement} · outstanding=${partial.body?.outstandingMinor} · paid=${partial.body?.paidMinor}`);

  console.log("\n5) settle the rest: ₱300 cash (₱500 handed over) + ₱300 utang");
  const split = await call(`/admin/orders/${order2.id}/payments`, {
    method: "POST", token, storeId,
    body: {
      idempotencyKey: `n2probe-split-${order2.id}`,
      tenders: [
        { methodCode: "cash", amountMinor: 30000, tenderedMinor: 50000 },
        { methodCode: "credit", amountMinor: 30000 },
      ],
    },
  });
  console.log(`   POST payments → HTTP ${split.status} · settlement=${split.body?.settlement} · outstanding=${split.body?.outstandingMinor} · change=${split.body?.changeMinor}`);

  const ledger = await prisma.creditEntry.findMany({ where: { orderId: order2.id }, select: { amountMinor: true, type: true } });
  const balance = await prisma.storeCustomer.findUnique({ where: { id: customerId }, select: { creditBalanceMinor: true } });
  const order = await prisma.order.findUnique({ where: { id: order2.id }, select: { paymentStatus: true } });
  console.log(`   credit ledger entries=${ledger.length} (${ledger.map((l) => `${l.type} ${l.amountMinor}`).join(", ")}) · customer balance=${balance?.creditBalanceMinor} · order.paymentStatus=${order?.paymentStatus}`);

  console.log("\n6) idempotent replay (same key, same rows)");
  const replay = await call(`/admin/orders/${order2.id}/payments`, {
    method: "POST", token, storeId,
    body: { idempotencyKey: `n2probe-split-${order2.id}`, tenders: [{ methodCode: "cash", amountMinor: 30000 }] },
  });
  const rowCount = await prisma.payment.count({ where: { orderId: order2.id } });
  console.log(`   replay → HTTP ${replay.status} · rows in DB=${rowCount} (expect 3) · paid=${replay.body?.paidMinor}`);

  console.log("\n7) overpay guard: ₱1 on a fully-paid order");
  const over = await call(`/admin/orders/${order2.id}/payments`, {
    method: "POST", token, storeId,
    body: { idempotencyKey: `n2probe-over-${order2.id}`, tenders: [{ methodCode: "cash", amountMinor: 100 }] },
  });
  console.log(`   POST payments → HTTP ${over.status} · ${over.body?.message}`);

  console.log("\n8) validation: e-wallet without a reference");
  const noRef = await call(`/admin/orders/${order2.id}/payments`, {
    method: "POST", token, storeId,
    body: { idempotencyKey: `n2probe-noref-${order2.id}`, tenders: [{ methodCode: "gcash", amountMinor: 100 }] },
  });
  console.log(`   POST payments → HTTP ${noRef.status} · ${JSON.stringify(noRef.body?.errors ?? noRef.body?.message)}`);

  // The nested-object validation bug (errors swallowed → invalid tender accepted) must be
  // gone: amountMinor 0 has to be rejected AT THE BOUNDARY with the item path named.
  const badItem = await call(`/admin/orders/${order2.id}/payments`, {
    method: "POST", token, storeId,
    body: { idempotencyKey: `n2probe-baditem-${order2.id}`, tenders: [{ methodCode: "cash", amountMinor: 0 }] },
  });
  console.log(`   POST payments (amountMinor 0) → HTTP ${badItem.status} · ${JSON.stringify(badItem.body?.errors ?? badItem.body?.message)}`);

  console.log("\n9) derived settlement + drawer effect");
  const summary = await call(`/admin/orders/${order2.id}/payments`, { token, storeId });
  const report = await call(`/admin/registers/report?kind=x&sessionId=${sessionId}`, { token, storeId });
  console.log(`   GET payments → settlement=${summary.body?.summary?.settlement} · tenders=${summary.body?.summary?.tenders?.length}`);
  console.log(`   X-report → cashSales=${report.body?.report?.session?.live?.cashSalesMinor} · nonCash=${report.body?.report?.session?.live?.nonCashSalesMinor} · expected=${report.body?.report?.session?.live?.expectedMinor} · movements=${report.body?.report?.movements?.length}`);

  console.log("\n10) cross-tenant: store B cannot pay store A's order");
  const other = await prisma.store.create({ data: { slug: `n2probe-other-${Date.now()}`, name: "N2 Probe Other", settings: { create: { requireOpenShift: false } } } });
  await prisma.userStore.create({ data: { userId: admin!.id, storeId: other.id, role: "OWNER", status: "ACTIVE" } });
  const foreign = await call(`/admin/orders/${order2.id}/payments`, {
    method: "POST", token, storeId: other.id,
    body: { idempotencyKey: `n2probe-tenant-${order2.id}`, tenders: [{ methodCode: "cash", amountMinor: 100 }] },
  });
  console.log(`   store B POST payments → HTTP ${foreign.status} · ${foreign.body?.message}`);
  await cleanup(other.id, "none");

  console.log("\n11) tenant isolation of the method registry");
  const foreignMethods = await call("/admin/payment-methods", { token, storeId: other.id });
  console.log(`   (store B registry was seeded separately: ${(foreignMethods.body?.methods ?? []).length} rows returned before cleanup)`);
}

async function main() {
  const tag = `n2probe${Date.now()}`;
  const store = await prisma.store.create({
    data: { slug: tag, name: "N2 Probe Store", settings: { create: { requireOpenShift: true, deliveryEnabled: true } } },
  });
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${tag}-SKU`, name: "N2 Probe Item", priceMinor: 30000, isActive: true } });
  const customer = await prisma.customer.create({ data: { name: "N2 Probe Buyer", phone: null, email: null, passwordHash: null } });
  const storeCustomer = await prisma.storeCustomer.create({
    data: { storeId: store.id, customerId: customer.id, creditApproved: true, creditLimitMinor: 500000, creditBalanceMinor: 0 },
  });
  try {
    await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 10, quantityReserved: 0 } });
    await probe(store.id, product.id, storeCustomer.id);
  } finally {
    await cleanup(store.id, product.id);
    await prisma.customer.deleteMany({ where: { id: customer.id } });
    await prisma.$disconnect();
  }
}

void main().catch((e) => { console.error(e); process.exit(1); });