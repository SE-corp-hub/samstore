// Unique-key race class: find-then-create on a unique key turns a double submit into a raw
// P2002 → HTTP 500. Both sites are now atomic (upsert / P2002 → conflict) — this proves it
// against the real database, with real concurrency.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./prisma-repositories.js";
import { PrismaCartRepository } from "./prisma-repositories.js";
import { randomId } from "./repositories.js";
import { VoucherAdminService } from "../admin/voucher-admin.service.js";

const run = `RC${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];

after(async () => {
  if (storeIds.length) {
    await prisma.cartItem.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.cart.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.voucherRedemption.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.voucher.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.product.deleteMany({ where: { storeId: { in: storeIds } } });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

test("cart: two concurrent adds of the same product merge instead of throwing P2002", async () => {
  const store = await prisma.store.create({ data: { slug: `${run}-cart`.toLowerCase(), name: `Race ${run}` } });
  storeIds.push(store.id);
  const product = await prisma.product.create({
    data: { storeId: store.id, sku: `${run}-SKU`, name: "Race Product", priceMinor: 1000, isActive: true },
  });
  const cart = await prisma.cart.create({ data: { storeId: store.id, token: `cart_${randomId()}`, status: "OPEN" } });

  const repo = new PrismaCartRepository();
  const results = await Promise.allSettled([
    repo.addItem(cart.id, store.id, product.id, 1, 1000),
    repo.addItem(cart.id, store.id, product.id, 1, 1000),
  ]);
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(rejected.length, 0, `no add may fail: ${JSON.stringify(rejected.map((r) => (r as PromiseRejectedResult).reason?.message))}`);

  const item = await prisma.cartItem.findUnique({
    where: { cartId_productId: { cartId: cart.id, productId: product.id } },
    select: { quantity: true },
  });
  assert.equal(item?.quantity, 2, "both adds are counted exactly once");
});

test("voucher: a duplicate code is a conflict, never a raw P2002", async () => {
  const store = await prisma.store.create({ data: { slug: `${run}-vch`.toLowerCase(), name: `Race ${run}` } });
  storeIds.push(store.id);
  const svc = new VoucherAdminService();
  const input = { code: `${run}-VC`, discountMinor: 5000 };

  const first = await svc.create(store.id, input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await svc.create(store.id, input);
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && "type" in second.error ? second.error.type : "", "conflict");

  // Concurrent creates race too — the winner takes it, the loser gets the same clean conflict.
  const code2 = `${run}-VC2`;
  const raced = await Promise.allSettled([svc.create(store.id, { code: code2, discountMinor: 5000 }), svc.create(store.id, { code: code2, discountMinor: 5000 })]);
  const okCount = raced.filter((r) => r.status === "fulfilled" && r.value.ok).length;
  const conflictCount = raced.filter((r) => r.status === "fulfilled" && !r.value.ok).length;
  assert.equal(okCount, 1, "exactly one create wins");
  assert.equal(conflictCount, 1, "the other reports a conflict");
  assert.equal(raced.filter((r) => r.status === "rejected").length, 0, "nothing throws");
});
