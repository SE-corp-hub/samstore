// Truck stock from SE Corp Hub, against the real DB:
//   * a confirmed load moves sacks from the store's own location to the truck's place, which is made the first
//     time and marked for the owner to check; the same move offered again changes nothing;
//   * a closed day moves the good sacks back and takes the rest off the truck, with why;
//   * a load the shelf can't cover, an unknown item or a location that isn't there is refused in words, and
//     nothing moves;
//   * the beat answers every move the hub offers.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { InMemoryCartRepository, InMemoryCatalogRepository, InMemoryStoreRepository } from "../persistence/repositories.js";
import { HubOrderService, syncWithHub } from "./hub-orders.service.js";
import { hubTruckApplier, readTruckMove, TRUCK_DOC, type HubTruckMove } from "./hub-truck.js";

const run = `HTR${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
let seq = 0;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.stockMovement.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  await prisma.$disconnect();
});

async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `Truck stock ${seq}` } });
  storeIds.push(store.id);
  const main = await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const ers = await prisma.warehouse.create({ data: { storeId: store.id, name: "Extra Rice Store", code: "S2", type: "STORE" } });
  const dino = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-D25`, name: "Dinorado 25kg", priceMinor: 130_000, costMinor: 115_000 } });
  const jas = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-J25`, name: "Jasmine 25kg", priceMinor: 120_000, costMinor: 105_000 } });
  await prisma.stockLevel.createMany({
    data: [
      { storeId: store.id, productId: dino.id, warehouseId: ers.id, quantityOnHand: 40 },
      { storeId: store.id, productId: jas.id, warehouseId: ers.id, quantityOnHand: 12 },
      { storeId: store.id, productId: dino.id, warehouseId: main.id, quantityOnHand: 100 },
    ],
  });
  const on = async (warehouseId: string, productId: string) =>
    (await prisma.stockLevel.findFirst({ where: { storeId: store.id, warehouseId, productId } }))?.quantityOnHand ?? 0;
  const truck = () => prisma.warehouse.findFirst({ where: { storeId: store.id, name: "Truck: Ric" } });
  return { storeId: store.id, slug: store.slug, main, ers, dino, jas, on, truck };
}

const move = (m: Partial<HubTruckMove> & Pick<HubTruckMove, "id" | "kind">): HubTruckMove => ({ truck: "Truck: Ric", location: "S2", day: "2026-11-25", items: [], back: [], out: [], ...m });
const apply = hubTruckApplier(prisma);

test("a load goes to the truck's own place, once; the close brings back what came back and takes off the rest", async () => {
  const fx = await fixture();
  const load = move({ id: 1, kind: "load", items: [{ name: "Dinorado 25kg", quantity: 30 }, { name: "jasmine  25KG", quantity: 10 }] });
  assert.equal(await apply(fx.storeId, load), null);
  const truck = await fx.truck();
  assert.ok(truck, "the truck's place is made the first time");
  assert.deepEqual([truck.type, truck.needsReview, truck.isActive], ["WAREHOUSE", true, true]);
  assert.deepEqual([await fx.on(fx.ers.id, fx.dino.id), await fx.on(truck.id, fx.dino.id)], [10, 30]);
  assert.deepEqual([await fx.on(fx.ers.id, fx.jas.id), await fx.on(truck.id, fx.jas.id)], [2, 10]);
  assert.equal(await fx.on(fx.main.id, fx.dino.id), 100, "the main store's shelf is not the one this truck loads from");

  // Offered again (our answer was lost): nothing moves twice.
  assert.equal(await apply(fx.storeId, load), null);
  assert.deepEqual([await fx.on(fx.ers.id, fx.dino.id), await fx.on(truck.id, fx.dino.id)], [10, 30]);

  // The day: 5 Dinorado sold, 1 Jasmine given as a sample, the rest came back good.
  const close = move({
    id: 2, kind: "close",
    back: [{ name: "Dinorado 25kg", quantity: 25 }, { name: "Jasmine 25kg", quantity: 9 }],
    out: [{ name: "Dinorado 25kg", quantity: 5, why: "5 sold" }, { name: "Jasmine 25kg", quantity: 1, why: "1 given as a sample" }],
  });
  assert.equal(await apply(fx.storeId, close), null);
  assert.equal(await apply(fx.storeId, close), null);
  assert.deepEqual([await fx.on(fx.ers.id, fx.dino.id), await fx.on(truck.id, fx.dino.id)], [35, 0]);
  assert.deepEqual([await fx.on(fx.ers.id, fx.jas.id), await fx.on(truck.id, fx.jas.id)], [11, 0]);

  // The stock book: every row names the hub's move, and the sacks that left say why.
  const rows = await prisma.stockMovement.findMany({ where: { storeId: fx.storeId, documentType: TRUCK_DOC }, orderBy: { createdAt: "asc" } });
  assert.equal(rows.filter((r) => r.documentId === "load:1").length, 4, "out of the store and into the truck, for two items");
  const off = rows.filter((r) => r.documentId === "close:2" && r.type === "ADJUST");
  assert.deepEqual(off.map((r) => [r.delta, r.warehouseId === truck.id]).sort(), [[-1, true], [-5, true]].sort());
  assert.ok(off.some((r) => r.note === "Truck: Ric, 2026-11-25 (SE Corp Hub): 5 sold"));

  // The next day uses the same place.
  assert.equal(await apply(fx.storeId, move({ id: 3, kind: "load", items: [{ name: "Dinorado 25kg", quantity: 4 }] })), null);
  assert.equal((await prisma.warehouse.count({ where: { storeId: fx.storeId } })), 3);
  assert.equal(await fx.on(truck.id, fx.dino.id), 4);
});

test("a move Sam Store can't do is refused in words and moves nothing", async () => {
  const fx = await fixture();
  // More than the shelf has: both items stay where they are.
  const tooMany = move({ id: 11, kind: "load", items: [{ name: "Jasmine 25kg", quantity: 5 }, { name: "Dinorado 25kg", quantity: 41 }] });
  assert.equal(await apply(fx.storeId, tooMany), 'Not enough "Dinorado 25kg" at Extra Rice Store in Sam Store: short by 1');
  assert.deepEqual([await fx.on(fx.ers.id, fx.dino.id), await fx.on(fx.ers.id, fx.jas.id)], [40, 12]);
  assert.equal(await fx.truck(), null, "a refused first load leaves no truck behind");

  assert.equal(await apply(fx.storeId, move({ id: 12, kind: "load", items: [{ name: "Milagrosa 25kg", quantity: 1 }] })), '"Milagrosa 25kg" is not an item in this Sam Store');
  assert.equal(await apply(fx.storeId, move({ id: 13, kind: "load", location: "S9", items: [{ name: "Dinorado 25kg", quantity: 1 }] })), "Sam Store has no open location with the code S9");
  assert.equal(await apply(fx.storeId, move({ id: 14, kind: "close", back: [{ name: "Dinorado 25kg", quantity: 1 }] })), "Sam Store has no location named Truck: Ric");

  // With no location named, the truck loads from the main store.
  const { location: _none, ...fromMain } = move({ id: 15, kind: "load", items: [{ name: "Dinorado 25kg", quantity: 10 }] });
  assert.equal(await apply(fx.storeId, fromMain), null);
  const truck = await fx.truck();
  assert.deepEqual([await fx.on(fx.main.id, fx.dino.id), await fx.on(truck!.id, fx.dino.id)], [90, 10]);
  // A close that asks for more than the truck has is refused whole.
  const over = move({ id: 16, kind: "close", back: [{ name: "Dinorado 25kg", quantity: 8 }], out: [{ name: "Dinorado 25kg", quantity: 3, why: "3 sold" }] });
  assert.equal(await apply(fx.storeId, over), 'Not enough "Dinorado 25kg" on Truck: Ric in Sam Store: short by 1');
  assert.deepEqual([await fx.on(fx.ers.id, fx.dino.id), await fx.on(truck!.id, fx.dino.id)], [40, 10]);
  // A truck the owner turned off takes no moves.
  await prisma.warehouse.update({ where: { id: truck!.id }, data: { isActive: false } });
  assert.match((await apply(fx.storeId, move({ id: 17, kind: "load", items: [{ name: "Dinorado 25kg", quantity: 1 }] }))) ?? "", /is turned off in Sam Store/);
});

test("a move is read strictly, and the beat answers each one the hub offers", async () => {
  assert.equal(readTruckMove({ id: 1, store: "s", truck: "Truck: Ric", kind: "load", items: [] }), null, "a load with nothing on it");
  assert.equal(readTruckMove({ id: 1, store: "s", truck: "Truck: Ric", kind: "load", items: [{ name: "Rice", quantity: 1.5 }] }), null);
  assert.equal(readTruckMove({ id: 1, store: "s", truck: "Truck: Ric", kind: "sell", items: [{ name: "Rice", quantity: 1 }] }), null);
  assert.equal(readTruckMove({ id: 1, store: "s", truck: "", kind: "close" }), null);
  assert.deepEqual(readTruckMove({ id: 4, store: " s ", truck: "Truck: Ric", kind: "close", out: [{ name: "Rice", quantity: 2, why: "2 sold" }] }), {
    store: "s",
    move: { id: 4, kind: "close", truck: "Truck: Ric", items: [], back: [], out: [{ name: "Rice", quantity: 2, why: "2 sold" }] },
  });

  const stores = new InMemoryStoreRepository();
  stores.seed({ id: "store-1", slug: "sam-store", name: "Sam Store", status: "ACTIVE" } as never);
  const seen: string[] = [];
  const svc = new HubOrderService(
    stores, new InMemoryCatalogRepository(), new InMemoryCartRepository(), {} as never,
    undefined, undefined, undefined, undefined, undefined, undefined,
    async (storeId, m) => {
      seen.push(`${storeId} ${m.kind}:${m.id} ${m.truck} from=${m.location ?? "main"}`);
      if (m.id === 22) return 'Not enough "Dinorado 25kg" at S2 in Sam Store: short by 4';
      if (m.id === 23) throw new Error("database hiccup");
      return null;
    },
  );
  let body: { truck?: unknown } = {};
  const calls: string[] = [];
  const truck = [
    { id: 21, store: "sam-store", location: "S2", truck: "Truck: Ric", kind: "load", day: "2026-11-25", items: [{ name: "Dinorado 25kg", quantity: 30 }] },
    { id: 22, store: "sam-store", truck: "Truck: Joy", kind: "load", items: [{ name: "Dinorado 25kg", quantity: 30 }] },
    { id: 23, store: "sam-store", truck: "Truck: Ana", kind: "close", back: [{ name: "Dinorado 25kg", quantity: 1 }] },
    { id: 24, store: "no-such-store", truck: "Truck: Ric", kind: "close" },
    { id: 25, store: "sam-store", truck: "Truck: Ric", kind: "load" },
    { store: "sam-store", truck: "Truck: Ric", kind: "close" },
  ];
  const hub = (async (_url: string, init: RequestInit = {}) => {
    calls.push(init.method ?? "GET");
    if (init.method === "POST") body = JSON.parse(String(init.body));
    return Response.json(init.method === "POST" ? { ok: true } : { stores: [], orders: [], truck });
  }) as unknown as typeof fetch;
  // Even a quick beat answers when a truck move came.
  await syncWithHub(svc, "https://hub.example", "h".repeat(40), hub, { full: false });
  assert.deepEqual(calls, ["GET", "POST"]);
  assert.deepEqual(seen, ["store-1 load:21 Truck: Ric from=S2", "store-1 load:22 Truck: Joy from=main", "store-1 close:23 Truck: Ana from=main"]);
  assert.deepEqual(body.truck, [
    { id: 21, ok: true },
    { id: 22, error: 'Not enough "Dinorado 25kg" at S2 in Sam Store: short by 4' },
    { id: 24, error: "Store not found" },
    { id: 25, error: "Sam Store could not read this truck move" },
  ], "a crash (23) is not answered: the hub offers it again; a move with no id is skipped");
});
