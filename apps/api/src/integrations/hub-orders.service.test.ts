import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckoutService } from "../checkout/checkout.service.js";
import { HubOrderService, hubLinkStatus, hubSecretOk, syncWithHub, type HubOrderRequest } from "./hub-orders.service.js";
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
  featured: false,
  tags: [],
  ...over,
});

function build(opts: { locate?: (storeId: string, code: string) => Promise<string | null> } = {}) {
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
  const sequences = new InMemoryOrderSequenceRepository();
  const checkout = new CheckoutService(stores, catalog, carts, orders, sequences, "test-claim-secret-0123456789");
  return { svc: new HubOrderService(stores, catalog, carts, checkout, undefined, opts.locate), orders, catalog, sequences, stores };
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

test("each beat fetches the hub's waiting orders, places them, and reports each result with the store's items", async () => {
  const { svc, orders } = build();
  const calls: { url: string; method: string; secret: string | null; body?: unknown }[] = [];
  const hub = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      secret: new Headers(init.headers).get("x-hub-secret"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return init.method === "POST"
      ? Response.json({ ok: true })
      : Response.json({
          stores: ["sam-store"],
          orders: [req(), req({ idempotencyKey: "hub-order-1002", items: [{ name: "Unknown Rice", quantity: 1 }] }), { idempotencyKey: "hub-order-1003" }],
        });
  }) as unknown as typeof fetch;
  await syncWithHub(svc, "https://hub.example/", "h".repeat(40), hub);
  await syncWithHub(svc, "https://hub.example/", "h".repeat(40), hub);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url} ${c.secret === "h".repeat(40)}`), [
    "GET https://hub.example/api/samstore true",
    "POST https://hub.example/api/samstore true",
    "GET https://hub.example/api/samstore true",
    "POST https://hub.example/api/samstore true",
  ]);
  assert.equal(orders.exportedForTests().orders.length, 1, "the same order fetched twice is placed once");
  const sent = calls[3]!.body as { results: { key: string; orderNumber?: string; totalMinor?: number; error?: string }[]; products: { store: string; products: { name: string }[] }[] };
  const [placed, refused, malformed] = sent.results;
  assert.equal(placed?.key, "hub-order-1001");
  assert.match(placed?.orderNumber ?? "", /-\d{6}$/);
  assert.equal(placed?.totalMinor, 2 * 150000 + 5000);
  assert.equal(refused?.key, "hub-order-1002");
  assert.match(refused?.error ?? "", /Unknown Rice/);
  assert.equal(malformed?.key, "hub-order-1003");
  assert.ok(malformed?.error, "a malformed order is refused with a reason, not a crash");
  assert.deepEqual(sent.products[0]?.products.map((p) => p.name), ["Samrice Dinorado 25kg", "Samrice Jasmine 25kg"]);
});

test("a hub that refuses the secret stops the beat before anything is placed", async () => {
  const { svc, orders } = build();
  const refuse = (async () => Response.json({ message: "Wrong hub secret" }, { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(syncWithHub(svc, "https://hub.example", "h".repeat(40), refuse), /401/);
  assert.equal(orders.exportedForTests().orders.length, 0);
});

test("each beat also sends how the store's hub orders stand now, so an edit here shows in the hub", async () => {
  const { svc: base } = build();
  const asked: { storeId: string; since: Date }[] = [];
  const now = { orderNumber: "SAMSTO-000007", status: "PREPARING", deliveryType: "delivery", totalMinor: 155000, deliveryFeeMinor: 5000, discountMinor: 0, items: [{ name: "Samrice Dinorado 25kg", quantity: 1, unitPriceMinor: 150000 }] };
  const svc = new HubOrderService(
    (base as unknown as { stores: InMemoryStoreRepository }).stores,
    (base as unknown as { catalog: InMemoryCatalogRepository }).catalog,
    (base as unknown as { carts: InMemoryCartRepository }).carts,
    (base as unknown as { checkout: CheckoutService }).checkout,
    async (storeId, since) => (asked.push({ storeId, since }), [now]),
  );
  let body: { updates?: unknown[] } = {};
  const hub = (async (_url: string, init: RequestInit = {}) => {
    if (init.method === "POST") body = JSON.parse(String(init.body));
    return Response.json(init.method === "POST" ? { ok: true } : { stores: ["sam-store", "no-such-store"], orders: [] });
  }) as unknown as typeof fetch;
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  assert.deepEqual(body.updates, [{ store: "sam-store", ...now }], "an unknown store sends nothing");
  assert.equal(asked[0]?.storeId, "store-1");
  assert.ok(Date.now() - asked[0]!.since.getTime() >= 3 * 86_400_000 - 1000, "the last 3 days of changes");
});

test("a quick beat with nothing waiting only asks; with an order waiting it answers in full", async () => {
  const { svc } = build();
  const calls: string[] = [];
  let waiting: unknown[] = [];
  const hub = (async (_url: string, init: RequestInit = {}) => {
    calls.push(init.method ?? "GET");
    return Response.json(init.method === "POST" ? { ok: true } : { stores: ["sam-store"], orders: waiting });
  }) as unknown as typeof fetch;
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub, { full: false });
  assert.deepEqual(calls, ["GET"], "nothing waiting: the hub's copy is left alone");
  waiting = [{ storeSlug: "sam-store", idempotencyKey: "quick-1", channel: "messenger", pageName: "Samrice", customerName: "Ana Cruz", customerPhone: "09171234567", deliveryType: "pickup", items: [{ name: "Samrice Dinorado 25kg", quantity: 1 }] }];
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub, { full: false });
  assert.deepEqual(calls, ["GET", "GET", "POST"], "an order came: place it and answer at once");
});

test("not enough stock is refused by name before checkout, so no order number is used up while it waits", async () => {
  const { svc, orders, sequences } = build();
  for (let i = 0; i < 3; i++) {
    const r = await svc.place(req({ items: [{ name: "Samrice Dinorado 25kg", quantity: 101 }] }));
    assert.equal(r.ok, false);
    if (!r.ok && r.error.type === "validation") assert.match(r.error.errors.join(" "), /Not enough "Samrice Dinorado 25kg": needs 101, 100 left/);
  }
  assert.equal(orders.exportedForTests().orders.length, 0);
  assert.equal(await sequences.nextOrderSequence("store-1"), 1, "three refusals took no order number");
});

test("a retry after a refusal places the order as the hub has it now, not the old quantities", async () => {
  const { svc } = build();
  // First try: 2 Dinorado + 1 Jasmine, refused (Jasmine short).
  const first = await svc.place(req({ items: [{ name: "Samrice Dinorado 25kg", quantity: 2 }, { name: "Samrice Jasmine 25kg", quantity: 500 }] }));
  assert.equal(first.ok, false);
  // The customer changed it in the hub: 3 Dinorado only.
  const again = await svc.place(req({ items: [{ name: "Samrice Dinorado 25kg", quantity: 3 }] }));
  assert.ok(again.ok);
  if (again.ok) assert.equal(again.value.totalMinor, 3 * 150000 + 5000);
});

test("an order already placed comes back the same even when the stock it holds leaves too little for a second one", async () => {
  const { svc, orders } = build();
  const a = await svc.place(req({ items: [{ name: "Samrice Dinorado 25kg", quantity: 100 }] }));
  assert.ok(a.ok);
  const b = await svc.place(req({ items: [{ name: "Samrice Dinorado 25kg", quantity: 100 }] }));
  assert.ok(b.ok, "a lost answer retried is the same order, not 'not enough stock'");
  if (a.ok && b.ok) assert.equal(a.value.orderNumber, b.value.orderNumber);
  assert.equal(orders.exportedForTests().orders.length, 1);
});

test("the hub's location code picks the selling location, and GCash is written on the order for staff", async () => {
  const { svc, orders } = build({ locate: async (storeId, code) => (storeId === "store-1" && code === "S2" ? "wh-s2" : null) });
  const r = await svc.place(req({ locationCode: "S2", paymentMethod: "gcash", notes: "Gate is blue" }));
  assert.ok(r.ok);
  const saved = orders.exportedForTests().orders.find((o) => r.ok && o.id === r.value.orderId);
  assert.equal(saved?.sellingLocationId, "wh-s2");
  assert.match(saved?.notes ?? "", /^Pays by GCash.*Gate is blue$/);
  const other = await svc.place(req({ idempotencyKey: "hub-order-2002", locationCode: "S9" }));
  assert.ok(other.ok, "an unknown code still takes the order");
  assert.equal(orders.exportedForTests().orders.find((o) => other.ok && o.id === other.value.orderId)?.sellingLocationId ?? null, null);
});

test("the shop link switched off or a minimum order does not turn away the hub's orders", async () => {
  const { svc, stores } = build();
  stores.seed({ ...store, guestOrderingEnabled: false, minOrderAmountMinor: 10_000_000 });
  const r = await svc.place(req());
  assert.ok(r.ok);
});

test("orders the store can't take are listed for staff with the reason, and drop off once placed", async () => {
  const { svc, catalog } = build();
  let waiting: unknown[] = [req({ items: [{ name: "Samrice Dinorado 25kg", quantity: 500 }] })];
  const hub = (async (_url: string, init: RequestInit = {}) =>
    Response.json(init.method === "POST" ? { ok: true } : { stores: ["sam-store"], orders: waiting })) as unknown as typeof fetch;
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  const st = hubLinkStatus("sam-store");
  assert.equal(st.stuck.length, 1);
  assert.equal(st.stuck[0]?.ref, "#1001");
  assert.equal(st.stuck[0]?.items, "500 × Samrice Dinorado 25kg");
  assert.match(st.stuck[0]?.error ?? "", /Not enough/);
  assert.equal(hubLinkStatus("other-store").stuck.length, 0, "another store never sees them");
  assert.ok(st.lastOkAt);
  catalog.seed(product({ quantityOnHand: 1000 }));
  waiting = [req({ items: [{ name: "Samrice Dinorado 25kg", quantity: 500 }] })];
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  assert.equal(hubLinkStatus("sam-store").stuck.length, 0);
});

test("a hub that can't be reached is shown in plain words", async () => {
  const { svc } = build();
  const refuse = (async () => Response.json({}, { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(syncWithHub(svc, "https://hub.example", "h".repeat(40), refuse));
  assert.match(hubLinkStatus("sam-store").lastError ?? "", /secret/);
});

test("selling prices: the linked location's own price is the one sent to the hub and used on its orders", async () => {
  const { svc: base, orders } = build();
  const parts = base as unknown as { stores: InMemoryStoreRepository; catalog: InMemoryCatalogRepository; carts: InMemoryCartRepository; checkout: CheckoutService };
  const svc = new HubOrderService(parts.stores, parts.catalog, parts.carts, parts.checkout, undefined,
    async (_s, code) => (code === "S2" ? "wh-s2" : null),
    async (_s, loc) => new Map(loc === "wh-s2" ? [["prod-dino-25", 155000]] : []),
  );
  const price = (list: Awaited<ReturnType<typeof svc.products>>, name: string) => list?.find((p) => p.name === name)?.priceMinor;
  assert.equal(price(await svc.products("sam-store"), "Samrice Dinorado 25kg"), 150000);
  assert.equal(price(await svc.products("sam-store", "S2"), "Samrice Dinorado 25kg"), 155000, "Store 2's own price");
  assert.equal(price(await svc.products("sam-store", "S2"), "Samrice Jasmine 25kg"), 140000, "no own price: the store's price");
  const r = await svc.place(req({ locationCode: "S2", deliveryFeeMinor: 0, items: [{ name: "Samrice Dinorado 25kg", quantity: 2 }] }));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.totalMinor, 2 * 155000);
  assert.equal(orders.exportedForTests().orders[0]?.notes ?? null, null, "same price on both sides: nothing to tell staff");
});

test("selling prices: the price the customer was told on the Page is kept, and staff see both prices", async () => {
  const { svc, orders } = build();
  // The store raised Dinorado to 1,500 a moment ago; the customer confirmed at 1,450 on the Page.
  const r = await svc.place(req({ deliveryFeeMinor: 0, items: [{ name: "Samrice Dinorado 25kg", quantity: 2, unitPriceMinor: 145000 }] }));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.value.totalMinor, 2 * 145000);
  const saved = orders.exportedForTests().orders[0];
  assert.equal(saved?.items[0]?.unitPriceMinor, 145000);
  assert.match(saved?.notes ?? "", /Samrice Dinorado 25kg: Page price ₱1,450, store price now ₱1,500\./);
});

test("selling prices: each linked location gets its own price list in the answer to the hub", async () => {
  const { svc: base } = build();
  const parts = base as unknown as { stores: InMemoryStoreRepository; catalog: InMemoryCatalogRepository; carts: InMemoryCartRepository; checkout: CheckoutService };
  const svc = new HubOrderService(parts.stores, parts.catalog, parts.carts, parts.checkout, undefined,
    async (_s, code) => (code === "S2" ? "wh-s2" : null),
    async () => new Map([["prod-dino-25", 155000]]),
  );
  let body: { products?: { store: string; location?: string; products: { name: string; priceMinor: number }[] }[] } = {};
  const hub = (async (_url: string, init: RequestInit = {}) => {
    if (init.method === "POST") body = JSON.parse(String(init.body));
    return Response.json(init.method === "POST" ? { ok: true } : { stores: ["sam-store"], links: [{ store: "sam-store" }, { store: "sam-store", location: "S2" }], orders: [] });
  }) as unknown as typeof fetch;
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  const dino = (i: number) => body.products?.[i]?.products.find((p) => p.name === "Samrice Dinorado 25kg")?.priceMinor;
  assert.deepEqual([body.products?.[0]?.location, dino(0), body.products?.[1]?.location, dino(1)], [undefined, 150000, "S2", 155000]);
});
