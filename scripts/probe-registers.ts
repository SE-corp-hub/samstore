// N1 live probe — drives the REAL API over HTTP: shift gate → open → cash sale →
// cash-out → X-report → close with a short count → Z-report.
// Cleanup ALWAYS runs (finally): a leftover UserStore row for the admin would hijack
// resolveTenant's default store and break unrelated admin screens.
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
  await prisma.payment.deleteMany({ where: { storeId } });
  await prisma.orderClaimToken.deleteMany({ where: { storeId } });
  await prisma.orderStatusHistory.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { storeId } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.registerSession.deleteMany({ where: { storeId } });
  await prisma.register.deleteMany({ where: { storeId } });
  await prisma.stockMovement.deleteMany({ where: { storeId } });
  await prisma.stockLevel.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.storeMembership.deleteMany({ where: { storeId } });
  await prisma.userStore.deleteMany({ where: { storeId } });
  await prisma.storeSettings.deleteMany({ where: { storeId } });
  await prisma.storeCounter.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
  console.log("\nprobe fixture cleaned up");
}

async function probe(storeId: string, productId: string, tag: string) {
  const admin = await prisma.user.findFirst({ where: { email: "admin@samstore.test" }, select: { id: true, email: true, name: true } });
  await prisma.userStore.create({ data: { userId: admin!.id, storeId, role: "OWNER", status: "ACTIVE" } });
  await prisma.storeMembership.create({
    data: { storeId, platformUserId: admin!.id, email: admin!.email, displayName: admin!.name ?? "Probe Admin", role: "OWNER", status: "ACTIVE", acceptedAt: new Date() },
  });

  const login = await call("/auth/login", { method: "POST", body: { email: "admin@samstore.test", password: "admin-pass-123" } });
  const token = login.body?.token as string;
  console.log(`login: HTTP ${login.status} · token ${token ? "ok" : "MISSING"}`);

  console.log("\n1) no shift → cash sale must be refused");
  const blocked = await call("/admin/pos/sell", { method: "POST", token, storeId, body: { items: [{ productId, quantity: 1 }], paymentMethod: "cash", tenderedMinor: 30000 } });
  console.log(`   POST /admin/pos/sell → HTTP ${blocked.status} · ${blocked.body?.message ?? JSON.stringify(blocked.body)}`);

  console.log("\n2) open the shift (float ₱500.00)");
  const opened = await call("/admin/registers/open", { method: "POST", token, storeId, body: { openingFloatMinor: 50000 } });
  const sessionId = opened.body?.session?.sessionId as string;
  console.log(`   POST /admin/registers/open → HTTP ${opened.status} · session ${sessionId?.slice(0, 8)} · expected ${opened.body?.session?.live?.expectedMinor}`);

  console.log("\n3) the same cash sale now succeeds");
  const sale = await call("/admin/pos/sell", { method: "POST", token, storeId, body: { items: [{ productId, quantity: 1 }], paymentMethod: "cash", tenderedMinor: 50000 } });
  console.log(`   POST /admin/pos/sell → HTTP ${sale.status} · ${sale.body?.orderNumber} · change ${sale.body?.changeMinor}`);
  const order = sale.body?.orderId ? await prisma.order.findUnique({ where: { id: sale.body.orderId }, select: { registerSessionId: true } }) : null;
  console.log(`   order bound to shift: ${order?.registerSessionId === sessionId}`);

  console.log("\n4) cash out ₱100.00 (bank drop)");
  const move = await call("/admin/registers/movements", { method: "POST", token, storeId, body: { type: "CASH_OUT", amountMinor: 10000, reason: "bank drop" } });
  console.log(`   POST /admin/registers/movements → HTTP ${move.status} · expected now ${move.body?.session?.live?.expectedMinor}`);
  const moveBlocked = await call("/admin/registers/movements", { method: "POST", token, storeId, body: { type: "CASH_OUT", amountMinor: -5 } });
  console.log(`   negative amount rejected → HTTP ${moveBlocked.status}`);

  console.log("\n5) X-report");
  const x = await call("/admin/registers/report?kind=x", { token, storeId });
  const r = x.body?.report;
  console.log(`   GET report?kind=x → HTTP ${x.status} · kind=${r?.kind} · cash sales ${r?.session?.live?.cashSalesMinor} · expected ${r?.session?.live?.expectedMinor} · movements ${r?.movements?.length}`);

  console.log("\n6) close the shift ₱5.00 short");
  const expected = (r?.session?.live?.expectedMinor as number) ?? 0;
  const closed = await call("/admin/registers/close", { method: "POST", token, storeId, body: { countedMinor: expected - 500, notes: "probe short" } });
  console.log(`   POST /admin/registers/close → HTTP ${closed.status} · counted ${closed.body?.session?.countedMinor} · expected ${closed.body?.session?.expectedMinor} · variance ${closed.body?.session?.varianceMinor}`);

  const doubleClose = await call("/admin/registers/close", { method: "POST", token, storeId, body: { countedMinor: expected } });
  console.log(`   second close → HTTP ${doubleClose.status} · ${doubleClose.body?.message ?? ""}`);

  console.log("\n7) Z-report");
  const z = await call(`/admin/registers/report?kind=z&sessionId=${sessionId}`, { token, storeId });
  console.log(`   GET report?kind=z → HTTP ${z.status} · status=${z.body?.report?.session?.status} · variance ${z.body?.report?.session?.varianceMinor} · closedBy ${Boolean(z.body?.report?.session?.closedBy)}`);

  console.log("\n8) cross-tenant: a second store never sees this shift");
  const other = await prisma.store.create({ data: { slug: `${tag}-other`, name: "N1 Probe Other" } });
  await prisma.userStore.create({ data: { userId: admin!.id, storeId: other.id, role: "OWNER", status: "ACTIVE" } });
  const foreign = await call("/admin/registers/report?kind=z", { token, storeId: other.id });
  console.log(`   store B Z-report → HTTP ${foreign.status} · ${foreign.body?.message ?? JSON.stringify(foreign.body)}`);
  await cleanup(other.id, "none");
}

async function main() {
  const tag = `n1probe${Date.now()}`;
  const store = await prisma.store.create({
    data: { slug: tag, name: "N1 Probe Store", settings: { create: { requireOpenShift: true, deliveryEnabled: true } } },
  });
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${tag}-SKU`, name: "N1 Probe Item", priceMinor: 30000, isActive: true } });
  try {
    await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 10, quantityReserved: 0 } });
    await probe(store.id, product.id, tag);
  } finally {
    await cleanup(store.id, product.id);
    await prisma.$disconnect();
  }
}

void main().catch((e) => { console.error(e); process.exit(1); });