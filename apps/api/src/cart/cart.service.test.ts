import { test } from "node:test";
import assert from "node:assert/strict";
import { CartService, generateCartToken } from "./cart.service.js";
import {
  InMemoryCartRepository,
  InMemoryCatalogRepository,
  type ProductRecord,
} from "../persistence/repositories.js";

function makeProduct(over: Partial<ProductRecord> = {}): ProductRecord {
  return {
    id: "prod-1",
    storeId: "store-1",
    sku: "SKU-001",
    name: "Kape Barako",
    description: null,
    priceMinor: 12000,
    isActive: true,
    categoryName: "Drinks",
    images: [],
    quantityOnHand: 50,
    quantityReserved: 0,
    ...over,
  };
}

function makeService() {
  const carts = new InMemoryCartRepository();
  const catalog = new InMemoryCatalogRepository();
  catalog.seed(
    makeProduct(),
    makeProduct({ id: "prod-2", sku: "SKU-002", name: "Turon", priceMinor: 8000, quantityOnHand: 30 }),
    makeProduct({ id: "prod-3", storeId: "store-2", sku: "SKU-003", name: "Other store item" }),
    makeProduct({ id: "prod-4", isActive: false, sku: "SKU-004", name: "Hidden" }),
  );
  const svc = new CartService(carts, catalog);
  return { svc, carts, catalog };
}

test("cart token has high entropy and is server-generated", () => {
  const a = generateCartToken();
  const b = generateCartToken();
  assert.match(a, /^cart_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a, b);
});

test("createCart returns an OPEN empty cart token", async () => {
  const { svc } = makeService();
  const r = await svc.createCart();
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const cart = await svc.getCart(r.value.token);
  assert.equal(cart.ok, true);
  if (!cart.ok) return;
  assert.equal(cart.value.status, "OPEN");
  assert.deepEqual(cart.value.items, []);
  assert.equal(cart.value.subtotalMinor, 0);
});

test("addItem binds store on first add and returns enriched cart", async () => {
  const { svc } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  const r = await svc.addItem(created.value.token, "prod-1", 2);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.storeId, "store-1");
  assert.equal(r.value.items.length, 1);
  assert.equal(r.value.items[0]?.name, "Kape Barako");
  assert.equal(r.value.items[0]?.unitPriceMinor, 12000);
  assert.equal(r.value.subtotalMinor, 24000);
});

test("adding the same product again upserts quantity", async () => {
  const { svc } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  await svc.addItem(created.value.token, "prod-1", 1);
  const r = await svc.addItem(created.value.token, "prod-1", 2);
  if (!r.ok) return;
  assert.equal(r.value.items[0]?.quantity, 3);
  assert.equal(r.value.subtotalMinor, 3 * 12000);
});

test("cross-store add is rejected", async () => {
  const { svc } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  await svc.addItem(created.value.token, "prod-1", 1); // binds to store-1
  const r = await svc.addItem(created.value.token, "prod-3", 1); // store-2 product
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "conflict");
});

test("inactive product is rejected", async () => {
  const { svc } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  const r = await svc.addItem(created.value.token, "prod-4", 1);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "conflict");
});

test("quantity above available stock is rejected", async () => {
  const { svc } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  const r = await svc.addItem(created.value.token, "prod-1", 51); // only 50 on hand
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "conflict");
  if (r.error.type === "conflict") assert.match(r.error.message, /50 in stock/);
});

test("updateQuantity sets a new quantity", async () => {
  const { svc } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  await svc.addItem(created.value.token, "prod-1", 1);
  const r = await svc.updateQuantity(created.value.token, "prod-1", 5);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.items[0]?.quantity, 5);
  assert.equal(r.value.subtotalMinor, 5 * 12000);
});

test("updateQuantity beyond stock is rejected", async () => {
  const { svc } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  await svc.addItem(created.value.token, "prod-2", 1);
  const r = await svc.updateQuantity(created.value.token, "prod-2", 31); // only 30
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "conflict");
});

test("removeItem deletes the line", async () => {
  const { svc } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  await svc.addItem(created.value.token, "prod-1", 2);
  await svc.addItem(created.value.token, "prod-2", 1);
  const r = await svc.removeItem(created.value.token, "prod-1");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.items.length, 1);
  assert.equal(r.value.items[0]?.productId, "prod-2");
});

test("invalid quantity is rejected", async () => {
  const { svc } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  const r = await svc.addItem(created.value.token, "prod-1", 0);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "validation");
});

test("unknown token is not found", async () => {
  const { svc } = makeService();
  const r = await svc.getCart("cart_nonexistent");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "not_found");
});

test("addItem to a converted cart is rejected", async () => {
  const { svc, carts } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  await svc.addItem(created.value.token, "prod-1", 1);
  // simulate checkout marking the cart converted
  const cart = (await carts.findByToken(created.value.token))!;
  await carts.save({ ...cart, status: "CONVERTED" });
  const r = await svc.addItem(created.value.token, "prod-2", 1);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.type, "conflict");
});

test("expired cart is rejected on get and add", async () => {
  const { svc, carts } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  await svc.addItem(created.value.token, "prod-1", 1);
  // expire the cart
  const cart = (await carts.findByToken(created.value.token))!;
  await carts.save({ ...cart, expiresAt: new Date(Date.now() - 1000) });

  const get = await svc.getCart(created.value.token);
  assert.equal(get.ok, false);
  if (get.ok) return;
  assert.equal(get.error.type, "conflict");

  const add = await svc.addItem(created.value.token, "prod-2", 1);
  assert.equal(add.ok, false);
  if (add.ok) return;
  assert.equal(add.error.type, "conflict");
});

test("fresh cart has a future expiry", async () => {
  const { svc, carts } = makeService();
  const created = await svc.createCart();
  if (!created.ok) return;
  const cart = (await carts.findByToken(created.value.token))!;
  assert.ok(cart.expiresAt && cart.expiresAt > new Date());
});