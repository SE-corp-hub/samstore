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

test("the hub's location code picks the selling location, and a GCash order waits in Payment review", async () => {
  const { svc, orders } = build({ locate: async (storeId, code) => (storeId === "store-1" && code === "S2" ? "wh-s2" : null) });
  const r = await svc.place(req({ locationCode: "S2", paymentMethod: "gcash", notes: "Gate is blue" }));
  assert.ok(r.ok);
  const saved = orders.exportedForTests().orders.find((o) => r.ok && o.id === r.value.orderId);
  assert.equal(saved?.sellingLocationId, "wh-s2");
  assert.equal(saved?.notes, "Gate is blue");
  assert.equal(saved?.paymentMethod, "gcash");
  assert.equal(saved?.paymentStatus, "RECEIVED", "GCash waits in Payment review until staff confirm it");
  const other = await svc.place(req({ idempotencyKey: "hub-order-2002", locationCode: "S9" }));
  assert.ok(other.ok, "an unknown code still takes the order");
  const cod = orders.exportedForTests().orders.find((o) => other.ok && o.id === other.value.orderId);
  assert.deepEqual([cod?.paymentMethod, cod?.paymentStatus], ["cod", "PENDING"], "cash on delivery is as before");
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

test("a hub that asks for customers gets the store's changed ones after its last copy; an older hub gets none", async () => {
  const { svc: base } = build();
  const asked: { storeId: string; after: { at: string; id: string }; limit: number }[] = [];
  const ana = { id: "sc1", changedAt: "2026-11-12T01:00:00.000Z", name: "Ana Cruz", phone: "09171234567", address: "Bauan", utangMinor: 50000, points: 4, location: "S2" };
  const svc = new HubOrderService(
    (base as unknown as { stores: InMemoryStoreRepository }).stores,
    (base as unknown as { catalog: InMemoryCatalogRepository }).catalog,
    (base as unknown as { carts: InMemoryCartRepository }).carts,
    (base as unknown as { checkout: CheckoutService }).checkout,
    undefined,
    undefined,
    undefined,
    undefined,
    async (storeId, after, limit) => (asked.push({ storeId, after, limit }), [ana]),
  );
  let body: { customers?: unknown[] } = {};
  let answer: Record<string, unknown> = { stores: ["sam-store"], orders: [] };
  const hub = (async (_url: string, init: RequestInit = {}) => {
    if (init.method === "POST") body = JSON.parse(String(init.body));
    return Response.json(init.method === "POST" ? { ok: true } : answer);
  }) as unknown as typeof fetch;
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  assert.equal(body.customers, undefined, "a hub that doesn't ask gets no customers");
  assert.equal(asked.length, 0);
  answer = { ...answer, customersAfter: [{ store: "sam-store", at: "2026-11-11T00:00:00.000Z", id: "sc0" }, { store: "no-such-store", at: "", id: "" }] };
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  assert.deepEqual(body.customers, [{ store: "sam-store", ...ana }], "an unknown store sends nothing");
  assert.deepEqual(asked, [{ storeId: "store-1", after: { at: "2026-11-11T00:00:00.000Z", id: "sc0" }, limit: 200 }]);
});

test("delivery taps from the hub move the order before the answer is built; one we can't act on goes back with why", async () => {
  const { svc: base } = build();
  const seen: string[] = [];
  let status = "READY";
  const svc = new HubOrderService(
    (base as unknown as { stores: InMemoryStoreRepository }).stores,
    (base as unknown as { catalog: InMemoryCatalogRepository }).catalog,
    (base as unknown as { carts: InMemoryCartRepository }).carts,
    (base as unknown as { checkout: CheckoutService }).checkout,
    // What we tell the hub afterwards is the order as the tap left it.
    async () => [{ orderNumber: "SAMSTO-000031", status, deliveryType: "delivery", totalMinor: 290000, deliveryFeeMinor: 0, discountMinor: 0, items: [] }],
    undefined, undefined, undefined, undefined,
    async (storeId, tap) => {
      seen.push(`${storeId} ${tap.orderNumber} ${tap.status} by=${tap.by} cash=${tap.cashMinor}`);
      if (tap.orderNumber === "SAMSTO-000099") return "This order is cancelled in Sam Store";
      if (tap.orderNumber === "SAMSTO-000500") throw new Error("database hiccup");
      status = tap.status;
      return null;
    },
  );
  const calls: string[] = [];
  let body: { taps?: unknown; updates?: { status: string }[] } = {};
  const taps = [
    { id: 7, store: "sam-store", orderNumber: "SAMSTO-000031", status: "DELIVERED", at: "2026-11-23T01:35:00Z", by: "rey", cashMinor: 290000 },
    { id: 8, store: "sam-store", orderNumber: "SAMSTO-000099", status: "OUT_FOR_DELIVERY", at: "2026-11-23T01:36:00Z", by: "jun" },
    { id: 9, store: "sam-store", orderNumber: "SAMSTO-000500", status: "DELIVERED" },
    { id: 10, store: "no-such-store", orderNumber: "SAMSTO-000031", status: "DELIVERED" },
    { id: 11, store: "sam-store", orderNumber: "SAMSTO-000031", status: "CANCELLED" },
    { store: "sam-store", orderNumber: "SAMSTO-000031", status: "DELIVERED" },
  ];
  const hub = (async (_url: string, init: RequestInit = {}) => {
    calls.push(init.method ?? "GET");
    if (init.method === "POST") body = JSON.parse(String(init.body));
    return Response.json(init.method === "POST" ? { ok: true } : { stores: ["sam-store"], orders: [], taps });
  }) as unknown as typeof fetch;
  // Even a quick beat answers in full when a tap came, so the hub hears at once.
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub, { full: false });
  assert.deepEqual(calls, ["GET", "POST"]);
  assert.deepEqual(seen, [
    "store-1 SAMSTO-000031 DELIVERED by=rey cash=290000",
    "store-1 SAMSTO-000099 OUT_FOR_DELIVERY by=jun cash=undefined",
    "store-1 SAMSTO-000500 DELIVERED by=undefined cash=undefined",
  ]);
  assert.equal(body.updates?.[0]?.status, "DELIVERED", "the same answer carries the order as the tap left it");
  assert.deepEqual(body.taps, [
    { id: 8, error: "This order is cancelled in Sam Store" },
    { id: 10, error: "Store not found" },
    { id: 11, error: "Sam Store could not read this tap" },
  ], "a crash (9) is not a refusal: the hub offers it again; a tap with no id is skipped");
});

test("a hub that sends no taps, and a Sam Store with no tap handler, behave as before", async () => {
  const { svc } = build();
  let body: Record<string, unknown> = {};
  const hub = (taps?: unknown) =>
    (async (_url: string, init: RequestInit = {}) => {
      if (init.method === "POST") body = JSON.parse(String(init.body));
      return Response.json(init.method === "POST" ? { ok: true } : { stores: ["sam-store"], orders: [], ...(taps ? { taps } : {}) });
    }) as unknown as typeof fetch;
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub());
  assert.equal("taps" in body, false, "nothing about taps is sent to an older hub");
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub([{ id: 1, store: "sam-store", orderNumber: "SAMSTO-000001", status: "DELIVERED" }]));
  assert.deepEqual(body.taps, [{ id: 1, error: "This Sam Store cannot take delivery taps yet" }]);
});

// ---- Link version 2: item codes, per-kilo items, the customer, price changes from the hub, selling days ----

test("every call says what this Sam Store understands, so a newer hub sends an older one nothing it would refuse", async () => {
  const { svc } = build();
  const seen: (string | null)[] = [];
  const hub = (async (_url: string, init: RequestInit = {}) => {
    seen.push(new Headers(init.headers).get("x-samstore-link"));
    return Response.json(init.method === "POST" ? { ok: true } : { stores: ["sam-store"], orders: [] });
  }) as unknown as typeof fetch;
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  assert.deepEqual(seen, ["3", "3"]);
});

/** A service with the database parts of the link (integrations/hub-extras.ts) replaced by what the test gives. */
function withExtras(extras: ConstructorParameters<typeof HubOrderService>[11]) {
  const b = build();
  const svc = new HubOrderService(b.stores, b.catalog, (b.svc as unknown as { carts: InMemoryCartRepository }).carts, (b.svc as unknown as { checkout: CheckoutService }).checkout, undefined, undefined, undefined, undefined, undefined, undefined, undefined, extras);
  return { ...b, svc };
}

test("rice sold per kilo is never offered to the Page, and an order for it is refused in plain words", async () => {
  const { svc, orders } = withExtras({ kiloIds: async () => new Set(["prod-jas-25"]) });
  assert.deepEqual((await svc.products("sam-store"))?.map((p) => p.sku), ["DINO-25"]);
  const r = await svc.place(req({ items: [{ name: "Samrice Jasmine 25kg", quantity: 2 }] }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match((r.error as { errors: string[] }).errors.join(" "), /sold per kilo, which the Page cannot order/);
  assert.equal(orders.exportedForTests().orders.length, 0, "nothing was held: 2 would have meant 2 grams");
});

test("an item is found by its code first, so a name changed here still matches the hub's order", async () => {
  const { svc } = build();
  const r = await svc.place(req({ items: [{ sku: "dino-25", name: "An old name the hub still has", quantity: 1 }] }));
  assert.ok(r.ok);
});

test("after an order is placed, its customer and its changed prices are passed on; a miss is tried again, never lost", async () => {
  const seen: unknown[] = [];
  let fail = true;
  const { svc, orders } = withExtras({
    afterPlace: async (storeId, orderNumber, info) => {
      if (fail) throw new Error("database blinked");
      seen.push({ storeId, orderNumber, info });
    },
  });
  const order = req({ customerRef: "sc_77", priceReason: "Suki, pays cash", priceBy: "owner", items: [{ name: "Samrice Dinorado 25kg", quantity: 2, unitPriceMinor: 140000 }, { name: "Samrice Jasmine 25kg", quantity: 1 }] });
  const first = await svc.place(order);
  assert.equal(first.ok, false, "the hub is asked to offer it again");
  if (!first.ok) assert.match((first.error as { errors: string[] }).errors[0]!, /could not finish saving it/);
  fail = false;
  const again = await svc.place(order);
  assert.ok(again.ok);
  assert.equal(orders.exportedForTests().orders.length, 1, "the same order, not a second one");
  if (!again.ok) return;
  assert.deepEqual(seen, [
    {
      storeId: "store-1",
      orderNumber: again.value.orderNumber,
      info: {
        customerRef: "sc_77",
        customerName: "Maria Santos",
        customerPhone: "0917 123 4567",
        address: "123 Rizal St, Poblacion, Bauan, Batangas",
        // Only the line sold at another price than the store's own.
        repriced: [{ productId: "prod-dino-25", catalogUnitPriceMinor: 150000 }],
        priceReason: "Suki, pays cash",
        priceBy: "owner",
      },
    },
  ]);
});

test("price changes from the hub are done before the answer, each one answered; selling days go only when asked", async () => {
  const done: string[] = [];
  const day = { day: "2026-11-25", location: "", salesMinor: 1_000_000, costMinor: 800_000, expensesMinor: 50_000, profitMinor: 150_000, orders: 4, noCostUnits: 0, hubSalesMinor: 290_000, hubOrders: 1 };
  const asks: number[] = [];
  const { svc } = withExtras({
    change: async (storeId, c) => {
      done.push(`${storeId} ${c.orderNumber} ${c.items.map((i) => `${i.sku ?? i.name}@${i.unitPriceMinor}`).join(",")} why=${c.reason} by=${c.by} as=${c.role}`);
      if (c.orderNumber === "SAMSTO-000002") return "Samrice Dinorado 25kg cannot go below ₱1,420";
      if (c.orderNumber === "SAMSTO-000003") throw new Error("database blinked");
      return null;
    },
    days: async (_storeId, count) => (asks.push(count), [day]),
  });
  let body: Record<string, unknown> = {};
  const calls: string[] = [];
  let answer: Record<string, unknown> = {};
  const hub = (async (_url: string, init: RequestInit = {}) => {
    calls.push(init.method ?? "GET");
    if (init.method === "POST") body = JSON.parse(String(init.body));
    return Response.json(init.method === "POST" ? { ok: true } : { stores: ["sam-store"], orders: [], ...answer });
  }) as unknown as typeof fetch;
  const change = (id: unknown, orderNumber: string, more: Record<string, unknown> = {}) => ({ id, store: "sam-store", orderNumber, items: [{ sku: "DINO-25", name: "Samrice Dinorado 25kg", unitPriceMinor: 140000 }], reason: "Suki price", by: "owner", role: "owner", ...more });
  answer = {
    changes: [
      change(1, "SAMSTO-000001"),
      change(2, "SAMSTO-000002", { role: "manager", by: "lea" }),
      change(3, "SAMSTO-000003"),
      change(4, "SAMSTO-000004", { store: "no-such-store" }),
      change(5, "SAMSTO-000005", { reason: "" }),
      change(6, "SAMSTO-000006", { items: [{ name: "Samrice Dinorado 25kg", unitPriceMinor: -5 }] }),
      change("x", "SAMSTO-000007"),
    ],
    daysWanted: 0,
  };
  // Even a quick beat answers when a price change waits, so the hub hears in seconds.
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub, { full: false });
  assert.deepEqual(calls, ["GET", "POST"]);
  assert.deepEqual(done, [
    "store-1 SAMSTO-000001 DINO-25@140000 why=Suki price by=owner as=owner",
    "store-1 SAMSTO-000002 DINO-25@140000 why=Suki price by=lea as=manager",
    "store-1 SAMSTO-000003 DINO-25@140000 why=Suki price by=owner as=owner",
  ]);
  assert.deepEqual(body.changes, [
    { id: 1, ok: true },
    { id: 2, error: "Samrice Dinorado 25kg cannot go below ₱1,420" },
    { id: 4, error: "Store not found" },
    { id: 5, error: "Sam Store could not read this price change" },
    { id: 6, error: "Sam Store could not read this price change" },
  ], "a crash (3) is not a refusal: the hub offers it again; one with no id is skipped");
  assert.equal("days" in body, false, "the hub's copy is fresh");

  answer = { daysWanted: 7 };
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  assert.deepEqual(asks, [7]);
  assert.deepEqual(body.days, [{ store: "sam-store", ...day }]);
  assert.equal("changes" in body, false);

  // An older hub asks for neither, and is sent neither.
  answer = {};
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  assert.equal("days" in body, false);
  assert.equal("changes" in body, false);
});

test("a Sam Store without the database parts refuses a price change in plain words", async () => {
  const { svc } = build();
  assert.equal(await svc.change("sam-store", { orderNumber: "SAMSTO-000001", items: [{ name: "x", unitPriceMinor: 1 }], reason: "r", by: "o", role: "owner" }), "This Sam Store cannot take price changes from the hub yet");
  assert.deepEqual(await svc.days("sam-store", 7), []);
});

test("a hub that asks for buys gets each changed customer's buying line after its last copy; an older hub gets none", async () => {
  const asked: { storeId: string; after: { at: string; id: string }; limit: number }[] = [];
  const line = { id: "sc1", changedAt: "2026-11-26T01:00:00.000Z", places: [{ location: "S1", orders: 3, paidOrders: 3, firstAt: "2026-10-01T02:00:00.000Z", lastAt: "2026-11-26T01:00:00.000Z", spentMinor: 450000, recent: [], items: [] }] };
  const { svc } = withExtras({ buys: async (storeId, after, limit) => (asked.push({ storeId, after, limit }), [line]) });
  let body: { buys?: unknown[] } = {};
  let answer: Record<string, unknown> = { stores: ["sam-store"], orders: [] };
  const hub = (async (_url: string, init: RequestInit = {}) => {
    if (init.method === "POST") body = JSON.parse(String(init.body));
    return Response.json(init.method === "POST" ? { ok: true } : answer);
  }) as unknown as typeof fetch;
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  assert.equal(body.buys, undefined, "a hub that doesn't ask gets no buys");
  assert.equal(asked.length, 0);
  answer = { ...answer, buysAfter: [{ store: "sam-store", at: "2026-11-25T00:00:00.000Z", id: "sc0" }, { store: "no-such-store", at: "", id: "" }, { at: "x" }] };
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub);
  assert.deepEqual(body.buys, [{ store: "sam-store", ...line }], "an unknown store sends nothing");
  assert.deepEqual(asked, [{ storeId: "store-1", after: { at: "2026-11-25T00:00:00.000Z", id: "sc0" }, limit: 200 }]);
});
