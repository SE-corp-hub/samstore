// Live probe for the Module 4/9 fixes (guarded stock reservation + outbox-in-tx).
// Creates a THROWAWAY store + product with exactly ONE unit, drives the REAL public
// checkout API twice (cart → checkout), then verifies the DB and cleans up.
import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";
import { randomBytes } from "node:crypto";

const API = "http://localhost:4100";
const slug = `probe-sg-${Date.now()}`;
const token = randomBytes(24).toString("base64url");

async function main() {
  // ── fixture: 1 unit of stock ──
  const store = await prisma.store.create({
    data: {
      slug,
      name: "SG Probe Store",
      publicLink: { create: { slug, token, status: "ACTIVE" } },
      settings: { create: { allowGuestOrders: true, orderingPaused: false, deliveryEnabled: true, pickupEnabled: true, deliveryFeeMinor: 0 } },
    },
  });
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `SGP-${Date.now()}`, name: "SG Probe Item", priceMinor: 10000, isActive: true } });
  const level = await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 1, quantityReserved: 0 } });

  const publicUrl = `${API}/public/stores/${slug}?token=${encodeURIComponent(token)}`;
  const storeRes = await fetch(publicUrl);
  console.log(`public store link: HTTP ${storeRes.status}`);

  async function makeCart(label: string) {
    const cartRes = await fetch(`${API}/public/carts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeSlug: slug, storeToken: token }),
    });
    const cart = await cartRes.json();
    if (cartRes.status >= 300 || !cart?.token) {
      console.log(`cart ${label}: HTTP ${cartRes.status} ${JSON.stringify(cart).slice(0, 120)}`);
      return null;
    }
    const addRes = await fetch(`${API}/public/carts/${cart.token}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: product.id, quantity: 1 }),
    });
    console.log(`cart ${label}: created (items HTTP ${addRes.status})`);
    return cart.token as string;
  }

  async function checkout(cartToken: string, label: string) {
    const res = await fetch(`${API}/public/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cartToken,
        customerName: `SG Probe ${label}`,
        customerPhone: "+639178456200",
        deliveryType: "pickup",
        paymentMethod: "cod",
        idempotencyKey: `sgprobe-${label}-${Date.now()}`,
      }),
    });
    const body = await res.json();
    return { label, status: res.status, orderNumber: body.orderNumber ?? null, message: body.message ?? null };
  }

  // Both buyers build their carts BEFORE either checks out — the loser's request
  // reaches the database guard with the last unit already gone.
  const cartA = await makeCart("A");
  const cartB = await makeCart("B");
  if (!cartA || !cartB) throw new Error("cart setup failed");

  const first = await checkout(cartA, "A");
  console.log("buyer A (1 unit available):", JSON.stringify(first));
  const second = await checkout(cartB, "B");
  console.log("buyer B (same last unit):", JSON.stringify(second));

  // ── verify DB truth ──
  const lvl = await prisma.stockLevel.findUnique({ where: { id: level.id } });
  const orders = await prisma.order.findMany({ where: { storeId: store.id }, select: { orderNumber: true, status: true, fulfillmentType: true } });
  const moves = await prisma.stockMovement.findMany({ where: { storeId: store.id }, select: { type: true, delta: true, balanceAfter: true } });
  const events = await prisma.outboxEvent.findMany({ where: { storeId: store.id }, select: { eventType: true, status: true, aggregateId: true } });
  const logs = await prisma.notificationLog.findMany({ where: { storeId: store.id }, select: { id: true } });

  console.log(`stock: onHand=${lvl?.quantityOnHand} reserved=${lvl?.quantityReserved} (never negative, capped at what exists)`);
  console.log(`orders created: ${orders.length} →`, JSON.stringify(orders));
  console.log(`ledger: ${JSON.stringify(moves)}`);
  console.log(`outbox events: ${events.length} →`, JSON.stringify(events));
  console.log(`notification logs (worker drained): ${logs.length}`);

  // ── cleanup (FK-safe): probe store + everything it owns ──
  const orderIds = (await prisma.order.findMany({ where: { storeId: store.id }, select: { id: true } })).map((o) => o.id);
  await prisma.notificationLog.deleteMany({ where: { storeId: store.id } });
  await prisma.outboxEvent.deleteMany({ where: { storeId: store.id } });
  if (orderIds.length) {
    await prisma.stockMovement.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  const carts = await prisma.cart.findMany({ where: { storeId: store.id }, select: { id: true } });
  if (carts.length) {
    await prisma.cartItem.deleteMany({ where: { cartId: { in: carts.map((c) => c.id) } } });
    await prisma.cart.deleteMany({ where: { id: { in: carts.map((c) => c.id) } } });
  }
  await prisma.stockMovement.deleteMany({ where: { storeId: store.id } });
  await prisma.stockLevel.deleteMany({ where: { productId: product.id } });
  await prisma.product.deleteMany({ where: { id: product.id } });
  await prisma.storeSettings.deleteMany({ where: { storeId: store.id } });
  await prisma.publicStoreLink.deleteMany({ where: { storeId: store.id } });
  await prisma.storeCounter.deleteMany({ where: { storeId: store.id } });
  await prisma.store.delete({ where: { id: store.id } });
  console.log("probe fixture cleaned up");
  await prisma.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
