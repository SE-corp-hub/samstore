import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckoutService } from "../checkout/checkout.service.js";
import { HubOrderService, hubSecretOk, type HubOrderRequest } from "./hub-orders.service.js";
import {
  InMemoryStoreRepository,
  InMemoryCatalogRepository,
  InMemoryCartRepository,
  InMemoryOrderRepository,
  InMemoryOrderSequenceRepository,
  type StoreRecord,
  type ProductRecord,
} from "../persistence/repositories.js";

const store: StoreRecord = {
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
  pickupEnabled: true,
  minOrderAmountMinor: 0,
};
const product = (over: Partial<ProductRecord> = {}): ProductRecord => ({
  id: "prod-dino-25",
  storeId: "store-1",
  sku: "DINO-25",
  name: "Samrice Dinorado 25kg",
  description: null,
  priceMinor: 150000,
  isActive: true,
  categoryName: null,
  images: [],
  quantityOnHand: 100,
  quantityReserved: 0,
  ...over,
});

function build() {
  const stores = new InMemoryStoreRepository();
  stores.seed(store, { ...store, id: "store-2", slug: "other-store", name: "Other" });
  const catalog = new InMemoryCatalogRepository();
  catalog.seed(
    product(),
    product({ id: "prod-jas-25", sku: "JAS-25", name: "Samrice Jasmine 25kg", priceMinor: 140000 }),
    product({ id: "prod-other", storeId: "store-2", sku: "OTHER-1", name: "Other Shop Rice" }),
  );
  const carts = new InMemoryCartRepository();
  const orders = new InMemoryOrderRepository();
  const checkout = new CheckoutService(stores, catalog, carts, orders, new InMemoryOrderSequenceRepository(), "test-claim-secret-0123456789");
  return { svc: new HubOrderService(stores, catalog, carts, checkout), orders };
}

const req = (over: Partial<HubOrderRequest> = {}): HubOrderRequest => ({
  storeSlug: "sam-store",
  idempotencyKey: "hub-order-1001",
  externalRef: "#1001",
  channel: "messenger",
  pageName: "Samrice",
  customerName: "Maria Santos",
  customerPhone: "0917 123 4567",
  deliveryType: "delivery",
  address: "123 Rizal St, Poblacion, Bauan, Batangas",
  items: [{ name: "samrice dinorado 25kg", quantity: 2 }],
  ...over,
});

test("a hub order becomes a Sam Store order that says which page and channel it came from", async () => {
  const { svc, orders } = build();
  const r = await svc.place(req());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.value.orderNumber, /-\d{6}$/);
  // Priced by Sam Store's own catalog, plus the store's delivery fee.
  assert.equal(r.value.totalMinor, 2 * 150000 + 5000);
  const saved = orders.exportedForTests().orders.find((o) => o.id === r.value.orderId);
  assert.equal(saved?.source, "hub");
  assert.equal(saved?.sourceChannel, "messenger");
  assert.equal(saved?.sourcePage, "Samrice");
  assert.equal(saved?.externalRef, "#1001");
  assert.equal(saved?.customerName, "Maria Santos");
});

test("the same order sent twice is one order, not two", async () => {
  const { svc, orders } = build();
  const a = await svc.place(req());
  const b = await svc.place(req());
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.equal(a.value.orderNumber, b.value.orderNumber);
  assert.equal(orders.exportedForTests().orders.length, 1);
});

test("items match by SKU or by name, and the hub's agreed discount and fee are applied", async () => {
  const { svc } = build();
  const r = await svc.place(
    req({
      items: [
        { sku: "JAS-25", quantity: 1 },
        { name: "Samrice Dinorado 25kg", quantity: 1 },
      ],
      discountMinor: 10000,
      deliveryFeeMinor: 0,
    }),
  );
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.totalMinor, 140000 + 150000 - 10000);
});

test("an item Sam Store doesn't sell is refused by name, and nothing is created", async () => {
  const { svc, orders } = build();
  const r = await svc.place(req({ items: [{ name: "Mystery Rice 50kg", quantity: 1 }] }));
  assert.equal(r.ok, false);
  if (!r.ok && r.error.type === "validation") assert.match(r.error.errors.join(" "), /Mystery Rice 50kg/);
  assert.equal(orders.exportedForTests().orders.length, 0);
});

test("another store's items are never matched", async () => {
  const { svc } = build();
  const r = await svc.place(req({ items: [{ sku: "OTHER-1", quantity: 1 }] }));
  assert.equal(r.ok, false);
});

test("an unknown store is not found", async () => {
  const { svc } = build();
  const r = await svc.place(req({ storeSlug: "nope" }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.type, "not_found");
});

test("pick up needs no address and carries no delivery fee", async () => {
  const { svc } = build();
  const r = await svc.place(req({ deliveryType: "pickup", address: undefined }));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.totalMinor, 2 * 150000);
});

test("the door stays shut without the secret, with a wrong one, or when none is set", () => {
  const secret = "s".repeat(40);
  assert.equal(hubSecretOk(secret, secret), true);
  assert.equal(hubSecretOk("wrong".repeat(8), secret), false);
  assert.equal(hubSecretOk(undefined, secret), false);
  assert.equal(hubSecretOk("", ""), false);
  assert.equal(hubSecretOk("short", "short"), false); // a weak secret is treated as not set
});

test("the product list for the hub: this store's items only, with what can still be sold", async () => {
  const { svc } = build();
  const list = await svc.products("sam-store");
  assert.deepEqual(
    list?.map((p) => [p.name, p.priceMinor, p.available]).sort(),
    [
      ["Samrice Dinorado 25kg", 150000, 100],
      ["Samrice Jasmine 25kg", 140000, 100],
    ].sort(),
  );
  assert.equal(await svc.products("no-such-store"), null);
});
