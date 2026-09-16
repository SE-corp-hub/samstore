// M4 live probe — drives the REAL API over HTTP and proves the locked tax decisions on live data:
//   1. catalogue prices are VAT-INCLUSIVE (the VAT is extracted, never added);
//   2. the delivery fee is NOT VAT-able;
//   3. a voucher/loyalty discount reduces the VATable base BEFORE tax;
//   4. the store owner can HIDE the VAT lines on the slip — totals never move;
//   5. `vatEnabled=false` is a true kill switch (same totals, no VAT anywhere).
// It creates its own store fixture and cleans up in `finally` — the demo store is untouched.
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
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json };
}

const peso = (m: number) => `₱${(m / 100).toFixed(2)}`;
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function cleanup(storeId: string | null) {
  if (!storeId) return;
  await prisma.notificationLog.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.outboxEvent.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.cashMovement.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.payment.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.paymentMethod.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.orderClaimToken.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.orderStatusHistory.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.orderItem.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.order.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.registerSession.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.register.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.stockMovement.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.stockLevel.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.product.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.storeMembership.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.userStore.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.storeSettings.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.storeCounter.deleteMany({ where: { storeId } }).catch(() => undefined);
  await prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
  console.log("\nprobe fixture cleaned up");
}

async function main() {
  let storeId: string | null = null;
  try {
    // ── fixture: an isolated store whose prices INCLUDE VAT (the PH default) ──
    const admin = await prisma.user.findFirst({ where: { email: "admin@samstore.test" }, select: { id: true, email: true, name: true } });
    if (!admin) throw new Error("admin user missing — run the seed");
    const store = await prisma.store.create({
      data: {
        slug: `m4probe${Date.now().toString().slice(-6)}`, name: "M4 VAT Probe", currencyCode: "PHP", timezone: "Asia/Manila",
        status: "ACTIVE", accentColor: "#0d6efd", shareMessage: "probe",
      },
    });
    storeId = store.id;
    await prisma.storeSettings.create({
      data: { storeId, vatEnabled: true, vatRateBp: 1200, pricesIncludeVat: true, vatShowOnReceipt: true, deliveryFeeMinor: 5000, pickupEnabled: true },
    });
    await prisma.userStore.create({ data: { userId: admin.id, storeId, role: "OWNER", status: "ACTIVE" } });
    await prisma.storeMembership.create({
      data: { storeId, platformUserId: admin.id, email: admin.email, displayName: admin.name ?? "Probe Admin", role: "OWNER", status: "ACTIVE", acceptedAt: new Date() },
    });

    // ₱112.00 VAT-inclusive (→ ₱100.00 net + ₱12.00 VAT), and a ₱50.00 VAT-exempt item.
    const taxed = await prisma.product.create({ data: { storeId, sku: "M4-TAXED", name: "Taxed item (VAT-inclusive ₱112)", priceMinor: 11_200 } });
    const exempt = await prisma.product.create({ data: { storeId, sku: "M4-EXEMPT", name: "Exempt item (₱50)", priceMinor: 5_000, taxExempt: true } });
    const wh = await prisma.warehouse.create({ data: { storeId, name: "Probe WH", isDefault: true } });
    for (const p of [taxed, exempt]) {
      await prisma.stockLevel.create({ data: { storeId, productId: p.id, warehouseId: wh.id, quantityOnHand: 100 } });
    }

    const login = await call("/auth/login", { method: "POST", body: { email: "admin@samstore.test", password: "admin-pass-123" } });
    const token = login.body?.token as string;
    if (!token) throw new Error("login failed");
    console.log(`fixture store ${storeId} · login ok`);

    await call("/admin/registers/open", { method: "POST", token, storeId, body: { openingFloatMinor: 100_000 } });

    console.log("\n1) ₱112 inclusive sale → VAT is EXTRACTED (decision 1)");
    const sale1 = await call("/admin/pos/sell", {
      method: "POST", token, storeId,
      body: { items: [{ productId: taxed.id, quantity: 1 }], paymentMethod: "cash", tenderedMinor: 20_000 },
    });
    check("sale 1 accepted", sale1.status < 300, `HTTP ${sale1.status} ${JSON.stringify(sale1.body).slice(0, 120)}`);
    const o1 = await prisma.order.findFirst({ where: { id: sale1.body?.orderId ?? "__none__", storeId }, select: { totalMinor: true, vatableMinor: true, vatMinor: true, vatExemptMinor: true, vatRateBp: true } });
    check("order frozen the rate", o1?.vatRateBp === 1200, `vatRateBp=${o1?.vatRateBp}`);
    check("net-of-VAT base is ₱100.00", o1?.vatableMinor === 10_000, `vatable=${peso(o1?.vatableMinor ?? 0)}`);
    check("VAT is ₱12.00", o1?.vatMinor === 1_200, `vat=${peso(o1?.vatMinor ?? 0)}`);
    check("the customer still pays ₱112.00 (inclusive)", o1?.totalMinor === 11_200, `total=${peso(o1?.totalMinor ?? 0)}`);
    check("base + VAT == total", (o1?.vatableMinor ?? 0) + (o1?.vatMinor ?? 0) === o1?.totalMinor, `${peso((o1?.vatableMinor ?? 0) + (o1?.vatMinor ?? 0))}`);

    console.log("\n2) mixed cart: taxed ₱112 + VAT-exempt ₱50");
    const sale2 = await call("/admin/pos/sell", {
      method: "POST", token, storeId,
      body: { items: [{ productId: taxed.id, quantity: 1 }, { productId: exempt.id, quantity: 1 }], paymentMethod: "cash", tenderedMinor: 50_000 },
    });
    check("sale 2 accepted", sale2.status < 300, `HTTP ${sale2.status} ${JSON.stringify(sale2.body).slice(0, 120)}`);
    const o2 = await prisma.order.findFirst({ where: { id: sale2.body?.orderId ?? "__none__", storeId }, select: { totalMinor: true, vatableMinor: true, vatMinor: true, vatExemptMinor: true } });
    check("exempt item reported as non-VAT sales", o2?.vatExemptMinor === 5_000, `exempt=${peso(o2?.vatExemptMinor ?? 0)}`);
    check("VAT still ₱12.00 (only the taxed line)", o2?.vatMinor === 1_200, `vat=${peso(o2?.vatMinor ?? 0)}`);
    const sum2 = (o2?.vatableMinor ?? 0) + (o2?.vatMinor ?? 0) + (o2?.vatExemptMinor ?? 0);
    check("identity holds", sum2 === (o2?.totalMinor ?? -1), `sum=${peso(sum2)} total=${peso(o2?.totalMinor ?? 0)}`);

    console.log("\n3) the receipt carries the breakdown + a TIN");
    await call("/admin/settings", { method: "PATCH", token, storeId, body: { tin: "123-456-789-000" } });
    const receipt = await call(`/admin/orders/${sale2.body?.orderId}/receipt`, { token, storeId });
    check("receipt exposes vat", !!receipt.body?.vat, JSON.stringify(receipt.body?.vat ?? null));
    check("receipt shows the TIN it was given", receipt.body?.vat?.tin === "123-456-789-000", `${receipt.body?.vat?.tin}`);
    check("receipt vatable+VAT+exempt == total", ((receipt.body?.vat?.vatableMinor ?? 0) + (receipt.body?.vat?.vatMinor ?? 0) + (receipt.body?.vat?.vatExemptMinor ?? 0)) === receipt.body?.totalMinor);

    console.log("\n4) the owner HIDES VAT on the slip → display only, totals untouched (decision 1b)");
    const hide = await call("/admin/settings", { method: "PATCH", token, storeId, body: { vatShowOnReceipt: false } });
    const receipt2 = await call(`/admin/orders/${sale2.body?.orderId}/receipt`, { token, storeId });
    check("PATCH settings accepted", hide.status === 200, `HTTP ${hide.status}`);
    check("slip no longer prints the VAT lines", receipt2.body?.vat?.showOnReceipt === false, `showOnReceipt=${receipt2.body?.vat?.showOnReceipt}`);
    check("the VAT is still computed and recorded", (receipt2.body?.vat?.vatMinor ?? 0) === 1_200, `vat=${peso(receipt2.body?.vat?.vatMinor ?? 0)}`);
    check("the order total is unchanged", receipt2.body?.totalMinor === receipt.body?.totalMinor, `${peso(receipt2.body?.totalMinor ?? 0)}`);

    console.log("\n5) discount BEFORE tax (decision 3): a ₱20 voucher on a ₱112 basket");
    // Drive the REAL customer path: admin creates the voucher, a guest cart is checked out
    // with pickup (no delivery fee) + COD.
    const voucherCode = `M4VAT${Date.now().toString().slice(-5)}`;
        const voucherRes = await call("/admin/vouchers", {
          method: "POST", token, storeId,
          body: { code: voucherCode, discountMinor: 2_000, minOrderMinor: 0, description: "M4 probe" },
        });
        check("voucher created", voucherRes.status < 300, `HTTP ${voucherRes.status} code=${voucherCode}`);

    const cart = await call("/public/carts", { method: "POST" });
    const cartToken = (cart.body?.token ?? cart.body?.cartToken) as string;
    await call(`/public/carts/${cartToken}/items`, { method: "POST", body: { productId: taxed.id, quantity: 1 } });
    const checkout = await call("/public/checkout", {
      method: "POST",
      body: {
        cartToken, customerName: "M4 Probe Buyer", customerPhone: `+63917${String(Date.now()).slice(-7)}`,
        deliveryType: "pickup", paymentMethod: "cod",
        voucherCode, idempotencyKey: `m4probe-${Date.now()}`,
      },
    });
    const o5 = await prisma.order.findFirst({
      where: { storeId, id: (checkout.body?.orderId ?? "") as string },
      select: { totalMinor: true, discountMinor: true, vatableMinor: true, vatMinor: true, subtotalMinor: true },
    });
    if (checkout.status >= 300 || !o5) {
      check("checkout with a voucher succeeded", false, `HTTP ${checkout.status} ${JSON.stringify(checkout.body).slice(0, 140)}`);
    } else {
      check("the voucher discounted the sale by ₱20.00", o5.discountMinor === 2_000, `discount=${peso(o5.discountMinor)}`);
      check("the customer pays ₱92.00", o5.totalMinor === 9_200, `total=${peso(o5.totalMinor)}`);
      check("VAT is computed on the DISCOUNTED base (₱9.86, not ₱12.00)", o5.vatMinor === 986, `vat=${peso(o5.vatMinor)}`);
      const sum5 = o5.vatableMinor + o5.vatMinor;
      check("net + VAT == the discounted total", sum5 === o5.totalMinor, `${peso(o5.vatableMinor)} + ${peso(o5.vatMinor)} = ${peso(sum5)}`);
    }

    console.log("\n5b) the delivery fee is NOT VAT-able (decision 2) — a delivery checkout");
    const cart2 = await call("/public/carts", { method: "POST" });
    const cartToken2 = (cart2.body?.token ?? cart2.body?.cartToken) as string;
    await call(`/public/carts/${cartToken2}/items`, { method: "POST", body: { productId: taxed.id, quantity: 1 } });
    const checkout2 = await call("/public/checkout", {
      method: "POST",
      body: {
        cartToken: cartToken2, customerName: "M4 Probe Delivery", customerPhone: `+63918${String(Date.now()).slice(-7)}`,
        deliveryType: "delivery", deliveryAddressLine1: "12 Probe Street", paymentMethod: "cod",
        idempotencyKey: `m4probe-d-${Date.now()}`,
      },
    });
    const o6 = await prisma.order.findFirst({
      where: { storeId, id: (checkout2.body?.orderId ?? "") as string },
      select: { totalMinor: true, subtotalMinor: true, deliveryFeeMinor: true, vatableMinor: true, vatMinor: true, vatExemptMinor: true },
    });
    if (checkout2.status >= 300 || !o6) {
      check("delivery checkout succeeded", false, `HTTP ${checkout2.status} ${JSON.stringify(checkout2.body).slice(0, 140)}`);
    } else {
      check("a ₱50.00 delivery fee was charged", o6.deliveryFeeMinor === 5_000, `fee=${peso(o6.deliveryFeeMinor)}`);
      check("VAT is still ₱12.00 — the fee is untaxed", o6.vatMinor === 1_200, `vat=${peso(o6.vatMinor)}`);
      check("the fee shows as non-VAT sales on the slip", o6.vatExemptMinor === 5_000, `exempt=${peso(o6.vatExemptMinor)}`);
      const sum6 = o6.vatableMinor + o6.vatMinor + o6.vatExemptMinor;
      check("identity holds", sum6 === o6.totalMinor, `sum=${peso(sum6)} total=${peso(o6.totalMinor)}`);
    }

    console.log("\n6) vatEnabled=false is a kill switch: same totals, no VAT");
    await call("/admin/settings", { method: "PATCH", token, storeId, body: { vatEnabled: false } });
    const sale4 = await call("/admin/pos/sell", {
      method: "POST", token, storeId,
      body: { items: [{ productId: taxed.id, quantity: 1 }], paymentMethod: "cash", tenderedMinor: 20_000 },
    });
    const o4 = await prisma.order.findFirst({ where: { id: sale4.body?.orderId ?? "__none__", storeId }, select: { totalMinor: true, vatableMinor: true, vatMinor: true, vatRateBp: true, vatExemptMinor: true } });
    check("no VAT recorded", o4?.vatMinor === 0 && o4?.vatRateBp === 0, `vat=${peso(o4?.vatMinor ?? 0)} rate=${o4?.vatRateBp}`);
    check("the customer pays exactly the same ₱112.00", o4?.totalMinor === 11_200, `total=${peso(o4?.totalMinor ?? 0)}`);
    check("identity still holds with VAT off", (o4?.vatableMinor ?? 0) + (o4?.vatMinor ?? 0) + (o4?.vatExemptMinor ?? 0) === o4?.totalMinor, `sum=${peso(((o4?.vatableMinor ?? 0) + (o4?.vatMinor ?? 0) + (o4?.vatExemptMinor ?? 0)))} total=${peso(o4?.totalMinor ?? 0)}`);

    console.log("\n7) cross-tenant: another store cannot read this receipt");
    const other = await prisma.store.create({ data: { slug: `m4other${Date.now().toString().slice(-6)}`, name: "M4 Other", currencyCode: "PHP", timezone: "Asia/Manila", status: "ACTIVE" } });
    const xRes = await call(`/admin/orders/${sale2.body?.orderId}/receipt`, { token, storeId: other.id });
    check("receipt is 403/404 for another tenant", [403, 404].includes(xRes.status), `HTTP ${xRes.status}`);
    await prisma.store.delete({ where: { id: other.id } }).catch(() => undefined);

    console.log(`\n${failures === 0 ? "PROBE GREEN" : `PROBE RED — ${failures} check(s) failed`}`);
  } finally {
    await cleanup(storeId);
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});