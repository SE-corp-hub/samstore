// Rice Ops M4 — Resack, against the real DB. Proves the M4 "done when" list:
//   * 1 × 25 kg → 5 × 5 kg balances;
//   * Sinandomeng → Dinorado is labelled Ibang klase and carries the old cost;
//   * a 2% loss waits for the owner (and the stock still moves).
// Plus: Simulan/Tapusin with the rice "nasa resack" in between, cancel puts it back,
// Buksan ang sako, signatures required, location and tenant isolation.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { ResackService } from "./resack.service.js";
import type { Actor, SignatureInput } from "../people/people.service.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const run = `M4R${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.signature.deleteMany({ where });
    await prisma.approvalRequest.deleteMany({ where });
    await prisma.resackOutput.deleteMany({ where });
    await prisma.resackJob.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.kargador.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function fixture() {
  seq += 1;
  const slug = `${randomBytes(6).toString("hex").replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]!).slice(0, 6)}-${run}-${seq}`.toLowerCase();
  const store = await prisma.store.create({ data: { slug, name: `M4 ${run}` } });
  storeIds.push(store.id);
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const rice = (sku: string, name: string, grams: number, cost: number) =>
    prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-${sku}`, name, priceMinor: cost + 10_000, costMinor: cost, stockBaseUnit: "g", stockBaseQuantity: grams, stockConversionFamily: "Bigas", soldByWeight: grams === 1 } });
  const sin25 = await rice("SIN25", "Sinandomeng 25 kg", 25_000, 110_000);
  const sin5 = await rice("SIN5", "Sinandomeng 5kg", 5_000, 23_000);
  const din25 = await rice("DIN25", "Dinorado 25 kg", 25_000, 140_000);
  const loose = await rice("SINK", "Sinandomeng (per kilo)", 1, 4_600); // cost per KILO
  const kape = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}-KAPE`, name: "Kape", priceMinor: 1000 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: sin25.id, warehouseId: s1.id, quantityOnHand: 10 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: kape.id, warehouseId: s1.id, quantityOnHand: 10 } });
  const kargador = await prisma.kargador.create({ data: { storeId: store.id, name: "Mang Boy" } });
  const mk = async (name: string, role: "OWNER" | "STAFF", home: string | null): Promise<Actor> => {
    const u = await prisma.user.create({ data: { email: `${run}-${seq}-${name.replace(/\s/g, "")}@m4.test`, passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : "STAFF" } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId: home } });
    return { userId: u.id, role, homeLocationId: home };
  };
  return {
    storeId: store.id, s1: s1.id, s2: s2.id, sin25, sin5, din25, loose, kape, kargadorId: kargador.id,
    staff1: await mk("Ate Lorna", "STAFF", s1.id), staff2: await mk("Kuya Ben", "STAFF", s2.id), owner: await mk("Aling Nena", "OWNER", null),
  };
}

const staffSig: SignatureInput[] = [{ signerKind: "STAFF", imagePng: PNG }];
const withKargador = (k: string): SignatureInput[] => [...staffSig, { signerKind: "KARGADOR", kargadorId: k, imagePng: PNG }];
const onHand = async (fx: { storeId: string; s1: string }, productId: string, w = fx.s1) =>
  (await prisma.stockLevel.findFirst({ where: { storeId: fx.storeId, productId, warehouseId: w } }))?.quantityOnHand ?? null;
const msg = (r: unknown) => JSON.stringify((r as { error?: unknown }).error ?? r);
const svc = new ResackService();

test("M4: 1 × 25 kg → 5 × 5 kg balances — no loss, no approval, cost carried, ledger both ways", async () => {
  const fx = await fixture();
  const r = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.sin5.id, quantity: 5 }], signatures: staffSig });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) return;
  assert.match(r.value.docNumber, /^RSK-\d{6}$/);
  assert.deepEqual([r.value.gramsIn, r.value.gramsOut, r.value.lossGrams, r.value.needsApproval, r.value.varietyChange], [25_000, 25_000, 0, false, false]);
  assert.equal(await onHand(fx, fx.sin25.id), 9);
  assert.equal(await onHand(fx, fx.sin5.id), 5, "the 5 kg row is created at Store 1");
  const job = await prisma.resackJob.findUniqueOrThrow({ where: { id: r.value.id }, include: { outputs: true } });
  assert.equal(job.status, "FINISHED");
  assert.equal(job.inputValueMinor, 110_000);
  assert.deepEqual(job.outputs.map((o) => [o.quantity, o.grams, o.valueMinor]), [[5, 25_000, 110_000]], "the 5 kg sacks carry the 25 kg sack's cost");
  const moves = await prisma.stockMovement.findMany({ where: { storeId: fx.storeId, documentType: "RESACK", documentId: job.id }, select: { type: true, delta: true } });
  assert.deepEqual(moves.map((m) => `${m.type}${m.delta}`).sort(), ["RESACK_IN5", "RESACK_OUT-1"]);
  assert.equal(await prisma.approvalRequest.count({ where: { storeId: fx.storeId } }), 0);
});

test("M4: Sinandomeng → Dinorado is Ibang klase and carries Sinandomeng's cost", async () => {
  const fx = await fixture();
  const r = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.din25.id, quantity: 1 }], signatures: staffSig });
  assert.equal(r.ok && r.value.varietyChange, true, msg(r));
  const job = await prisma.resackJob.findUniqueOrThrow({ where: { id: r.ok ? r.value.id : "" }, include: { outputs: true } });
  assert.equal(job.varietyChange, true);
  assert.equal(job.outputs[0]!.valueMinor, 110_000, "not Dinorado's ₱1,400 cost — profit stays honest");
  assert.equal(await onHand(fx, fx.din25.id), 1);

  // The owner's report: 1 × Sinandomeng 25 kg → 1 × Dinorado 25 kg must work even when the
  // two products carry different conversion-family labels (Products page vs import).
  await prisma.product.update({ where: { id: fx.din25.id }, data: { stockConversionFamily: "dinorado" } });
  const again = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.din25.id, quantity: 1 }], signatures: staffSig });
  assert.equal(again.ok && again.value.varietyChange, true, msg(again));
  assert.equal(await onHand(fx, fx.din25.id), 2);
});

test("M4: a 2% loss waits for the owner — and the stock still moves", async () => {
  const fx = await fixture();
  const r = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.loose.id, quantity: 24_500 }], kargadorId: fx.kargadorId, signatures: withKargador(fx.kargadorId) });
  assert.equal(r.ok, true, msg(r));
  if (!r.ok) return;
  assert.deepEqual([r.value.lossGrams, r.value.lossBp, r.value.needsApproval], [500, 200, true]);
  const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r.value.approvalId! } });
  assert.equal(approval.kind, "LOSS_OVER_TOLERANCE");
  assert.equal(approval.status, "PENDING");
  assert.deepEqual(approval.approverRoles, ["OWNER"]);
  assert.match(approval.summary, /Short 0\.5 kg \(2\.00%\)/);
  assert.equal(await onHand(fx, fx.loose.id), 24_500, "24.5 kg loose on the shelf while the owner decides");
  const job = await prisma.resackJob.findUniqueOrThrow({ where: { id: r.value.id } });
  assert.equal(job.lossValueMinor, 2_200, "2% of ₱1,100 lost");
  assert.equal(job.approvalId, approval.id);

  // Within 1% needs no one.
  const ok = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.loose.id, quantity: 24_800 }], signatures: staffSig });
  assert.equal(ok.ok && ok.value.needsApproval, false, "0.8% is within tolerance");
});

test("M4: no signature, no resack — nothing moves", async () => {
  const fx = await fixture();
  const r = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.sin5.id, quantity: 5 }], signatures: [] });
  assert.equal(r.ok, false);
  assert.match(msg(r), /Missing signature: staff/);
  assert.equal(await onHand(fx, fx.sin25.id), 10);
  assert.equal(await onHand(fx, fx.sin5.id), null);
  assert.equal(await prisma.resackJob.count({ where: { storeId: fx.storeId } }), 0, "no half-written job");
  const withK = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.sin5.id, quantity: 5 }], kargadorId: fx.kargadorId, signatures: staffSig });
  assert.match(msg(withK), /porter/, "a kargador who did the work must sign");
});

test("M4: Simulan → nasa resack → Tapusin; Tapusin twice is refused; cancel puts the sack back", async () => {
  const fx = await fixture();
  const s = await svc.start(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 2, kargadorId: fx.kargadorId, signatures: withKargador(fx.kargadorId) });
  assert.equal(s.ok, true, msg(s));
  const id = s.ok ? s.value.id : "";
  assert.equal(await onHand(fx, fx.sin25.id), 8, "the 2 sacks are off the shelf");
  const inResack = await svc.list(fx.storeId, fx.staff1, { status: "STARTED" });
  assert.deepEqual(inResack.map((j) => [j.id, j.inputGrams]), [[id, 50_000]], "they show as nasa resack");

  const f = await svc.finish(fx.storeId, fx.staff1, id, { outputs: [{ productId: fx.sin5.id, quantity: 9 }, { productId: fx.loose.id, quantity: 4_700 }], signatures: withKargador(fx.kargadorId) });
  assert.equal(f.ok, true, msg(f));
  assert.deepEqual(f.ok && [f.value.gramsOut, f.value.lossGrams, f.value.needsApproval], [49_700, 300, false]);
  assert.equal(await onHand(fx, fx.sin5.id), 9);
  assert.equal(await onHand(fx, fx.loose.id), 4_700);
  const again = await svc.finish(fx.storeId, fx.staff1, id, { outputs: [{ productId: fx.sin5.id, quantity: 1 }], signatures: withKargador(fx.kargadorId) });
  assert.equal(again.ok, false, "a job finishes once");
  assert.equal(await onHand(fx, fx.sin5.id), 9);

  const s2 = await svc.start(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, signatures: staffSig });
  const id2 = s2.ok ? s2.value.id : "";
  assert.equal(await onHand(fx, fx.sin25.id), 7);
  assert.equal((await svc.cancel(fx.storeId, fx.staff1, id2, "")).ok, false, "a cancel needs a reason");
  assert.equal((await svc.cancel(fx.storeId, fx.staff1, id2, "walang bakanteng sako")).ok, true);
  assert.equal(await onHand(fx, fx.sin25.id), 8, "the sack is back");
  assert.equal((await svc.finish(fx.storeId, fx.staff1, id2, { outputs: [{ productId: fx.sin5.id, quantity: 5 }], signatures: staffSig })).ok, false);
});

test("M4: Buksan ang sako — one sack becomes loose kilos", async () => {
  const fx = await fixture();
  const r = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.loose.id, quantity: 24_900 }], openSack: true, signatures: staffSig });
  assert.equal(r.ok, true, msg(r));
  assert.equal(await onHand(fx, fx.loose.id), 24_900);
  const job = await prisma.resackJob.findUniqueOrThrow({ where: { id: r.ok ? r.value.id : "" }, include: { outputs: true } });
  assert.equal(job.openSack, true);
  assert.equal(job.outputs[0]!.valueMinor + (job.lossValueMinor ?? 0), 110_000);
  const notLoose = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.sin5.id, quantity: 5 }], openSack: true, signatures: staffSig });
  assert.equal(notLoose.ok, false, "opening a sack produces loose rice only");
});

test("M4: impossible or out-of-place resacks are refused", async () => {
  const fx = await fixture();
  const heavier = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.sin5.id, quantity: 6 }], signatures: staffSig });
  assert.match(msg(heavier), /weighs more/);
  const notRice = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.kape.id, inputQty: 1, outputs: [{ productId: fx.sin5.id, quantity: 1 }], signatures: staffSig });
  assert.match(msg(notRice), /weight of Kape/);
  const tooMany = await svc.resack(fx.storeId, fx.staff1, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 11, outputs: [{ productId: fx.sin5.id, quantity: 55 }], signatures: staffSig });
  assert.equal(!tooMany.ok && tooMany.error.type, "conflict", "only 10 sacks at Store 1");
  const wrongPlace = await svc.resack(fx.storeId, fx.staff2, { locationId: fx.s1, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.sin5.id, quantity: 5 }], signatures: staffSig });
  assert.equal(!wrongPlace.ok && wrongPlace.error.type, "forbidden", "Store 2 staff cannot resack Store 1's rice");
  const noneThere = await svc.resack(fx.storeId, fx.owner, { locationId: fx.s2, inputProductId: fx.sin25.id, inputQty: 1, outputs: [{ productId: fx.sin5.id, quantity: 5 }], signatures: staffSig });
  assert.equal(noneThere.ok, false, "Store 2 has no 25 kg sacks");
  assert.equal(await onHand(fx, fx.sin25.id), 10, "nothing moved");
});

test("M4: one store cannot see or finish another store's resack", async () => {
  const a = await fixture();
  const b = await fixture();
  const s = await svc.start(a.storeId, a.staff1, { locationId: a.s1, inputProductId: a.sin25.id, inputQty: 1, signatures: staffSig });
  const id = s.ok ? s.value.id : "";
  assert.equal((await svc.list(b.storeId, b.owner, { status: "ALL" })).some((j) => j.id === id), false);
  const r = await svc.finish(b.storeId, b.owner, id, { outputs: [{ productId: b.sin5.id, quantity: 5 }], signatures: staffSig });
  assert.equal(!r.ok && r.error.type, "not_found");
  const cross = await svc.resack(b.storeId, b.owner, { locationId: b.s1, inputProductId: a.sin25.id, inputQty: 1, outputs: [{ productId: b.sin5.id, quantity: 5 }], signatures: staffSig });
  assert.equal(cross.ok, false, "store B cannot use store A's product");
});
