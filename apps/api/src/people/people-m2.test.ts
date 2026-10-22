// Rice Ops M2 — people, signatures, approvals, numbering and drafts, against the real DB.
// Proves the M2 "done when" list: a step without its signatures is refused; S2 staff
// can't act for S1; 5 wrong PINs lock PIN login for 15 minutes. Plus: signatures are
// insert-only, approvals are decided once with the decider's PIN, numbers never repeat,
// and nothing crosses from one store to another.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../persistence/prisma-repositories.js";
import { WarehouseService } from "../admin/warehouse.service.js";
import { AuthService } from "../auth/auth.service.js";
import { PrismaAuthRepository } from "../auth/auth.repository.js";
import { verifyToken } from "../auth/auth.domain.js";
import { nextDocNumber, PeopleService, registerApprovalHandler, requestApproval, type Actor } from "./people.service.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const CONFIG = { jwtSecret: "m2-test-secret-not-real-0123456789abcdef", jwtExpiresIn: "1h" };
const run = `M2R${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.signature.deleteMany({ where });
    await prisma.approvalRequest.deleteMany({ where });
    await prisma.flowDraft.deleteMany({ where });
    await prisma.kargador.deleteMany({ where });
    await prisma.storeCounter.deleteMany({ where });
    await prisma.stockMovement.deleteMany({ where });
    await prisma.stockTransfer.deleteMany({ where });
    await prisma.stockLevel.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

let phoneSeq = Math.floor(Math.random() * 9_000);
function nextPhone() {
  phoneSeq += 1;
  return `+63917${String(Date.now() % 10_000).padStart(4, "0")}${String(phoneSeq % 1_000).padStart(3, "0")}`;
}

/** A store with S1 (default), S2 and WH; an owner, a manager, and a staff member whose home is S2. */
async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`.toLowerCase(), name: `M2 ${run}` } });
  storeIds.push(store.id);
  const s1 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 1", code: "S1", type: "STORE", isDefault: true } });
  const s2 = await prisma.warehouse.create({ data: { storeId: store.id, name: "Store 2", code: "S2", type: "STORE" } });
  const wh = await prisma.warehouse.create({ data: { storeId: store.id, name: "Warehouse", code: "WH", type: "WAREHOUSE" } });
  const mk = async (name: string, role: "OWNER" | "MANAGER" | "STAFF", homeLocationId: string | null) => {
    const u = await prisma.user.create({ data: { phone: nextPhone(), passwordHash: "x", name, role: role === "OWNER" ? "STORE_OWNER" : role } });
    userIds.push(u.id);
    await prisma.userStore.create({ data: { userId: u.id, storeId: store.id, role, homeLocationId } });
    return u;
  };
  const owner = await mk("Aling Nena", "OWNER", null);
  const manager = await mk("Kuya Jun", "MANAGER", null);
  const staff2 = await mk("Ate Lorna", "STAFF", s2.id);
  const product = await prisma.product.create({ data: { storeId: store.id, sku: `${run}-${seq}`, name: "Sinandomeng 25 kg", priceMinor: 130_000, costMinor: 110_000 } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, warehouseId: wh.id, quantityOnHand: 20 } });
  const actor = (u: { id: string }, role: string, home: string | null = null): Actor => ({ userId: u.id, role, homeLocationId: home });
  return {
    storeId: store.id, s1: s1.id, s2: s2.id, wh: wh.id, productId: product.id, owner, manager, staff2,
    ownerA: actor(owner, "OWNER"), managerA: actor(manager, "MANAGER"), staff2A: actor(staff2, "STAFF", s2.id),
  };
}

async function approvedTransfer(fx: Awaited<ReturnType<typeof fixture>>, to: string, qty = 5) {
  return prisma.stockTransfer.create({
    data: { storeId: fx.storeId, fromWarehouseId: fx.wh, toWarehouseId: to, productId: fx.productId, quantity: qty, status: "APPROVED", requestedById: fx.owner.id },
  });
}
const level = async (fx: { storeId: string; productId: string }, warehouseId: string) =>
  (await prisma.stockLevel.findFirst({ where: { storeId: fx.storeId, productId: fx.productId, warehouseId } }))?.quantityOnHand ?? null;
const msg = (r: { ok: boolean; error?: unknown }) => JSON.stringify((r as { error?: unknown }).error ?? "");

// ─────────────────────────────── signatures ───────────────────────────────

test("M2: receiving a transfer without the receiver's signature is refused and nothing moves", async () => {
  const fx = await fixture();
  const svc = new WarehouseService();
  const t = await approvedTransfer(fx, fx.s1);
  const r = await svc.completeTransfer(fx.storeId, t.id, fx.ownerA, []);
  assert.equal(r.ok, false);
  assert.match(msg(r), /Missing signature: staff/);
  assert.equal((await prisma.stockTransfer.findUnique({ where: { id: t.id } }))?.status, "APPROVED", "status rolled back");
  assert.equal(await level(fx, fx.wh), 20, "source untouched");

  const ok = await svc.completeTransfer(fx.storeId, t.id, fx.ownerA, [{ signerKind: "STAFF", imagePng: PNG }]);
  assert.equal(ok.ok, true, msg(ok));
  assert.equal(await level(fx, fx.s1), 5);
  const sigs = await prisma.signature.findMany({ where: { storeId: fx.storeId, documentType: "TRANSFER", documentId: t.id } });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0]!.signerUserId, fx.owner.id, "STAFF signer is the person logged in, never a typed name");
  assert.equal(sigs[0]!.signerName, "Aling Nena");
  assert.equal(sigs[0]!.step, "RECEIVE");
  assert.equal(sigs[0]!.locationId, fx.s1);
  assert.equal(sigs[0]!.imageSha256.length, 64);
});

test("M2: a bad signature image refuses the step (no partial save)", async () => {
  const fx = await fixture();
  const svc = new WarehouseService();
  const t = await approvedTransfer(fx, fx.s1);
  const r = await svc.completeTransfer(fx.storeId, t.id, fx.ownerA, [{ signerKind: "STAFF", imagePng: "data:image/png;base64,PHN2Zz4=" }]);
  assert.equal(r.ok, false);
  assert.equal(await prisma.signature.count({ where: { storeId: fx.storeId } }), 0);
  assert.equal(await level(fx, fx.wh), 20);
});

test("M2: signatures are insert-only — the database refuses an edit", async () => {
  const fx = await fixture();
  const people = new PeopleService();
  const r = await people.addSignatures(fx.storeId, fx.ownerA, { documentType: "COUNT", documentId: "cnt-1", step: "SUBMIT", locationId: fx.s1 }, [{ signerKind: "STAFF", imagePng: PNG }]);
  assert.equal(r.ok, true, msg(r));
  const sig = await prisma.signature.findFirstOrThrow({ where: { storeId: fx.storeId } });
  await assert.rejects(prisma.signature.update({ where: { id: sig.id }, data: { signerName: "Someone else" } }), /insert-only/);
  assert.equal((await prisma.signature.findUniqueOrThrow({ where: { id: sig.id } })).signerName, "Aling Nena");
});

test("M2: an unknown step cannot be signed at all", async () => {
  const fx = await fixture();
  const r = await new PeopleService().addSignatures(fx.storeId, fx.ownerA, { documentType: "TRANSFER", documentId: "x", step: "TELEPORT", locationId: null }, [{ signerKind: "STAFF", imagePng: PNG }]);
  assert.equal(r.ok, false);
});

// ─────────────────────────────── locations ───────────────────────────────

test("M2: S2 staff can't act for S1 — signing, receiving or drafting at S1 is refused", async () => {
  const fx = await fixture();
  const people = new PeopleService();
  const sigS1 = await people.addSignatures(fx.storeId, fx.staff2A, { documentType: "COUNT", documentId: "c1", step: "SUBMIT", locationId: fx.s1 }, [{ signerKind: "STAFF", imagePng: PNG }]);
  assert.equal(sigS1.ok, false);
  assert.equal(!sigS1.ok && sigS1.error.type, "forbidden");
  const sigS2 = await people.addSignatures(fx.storeId, fx.staff2A, { documentType: "COUNT", documentId: "c2", step: "SUBMIT", locationId: fx.s2 }, [{ signerKind: "STAFF", imagePng: PNG }]);
  assert.equal(sigS2.ok, true, msg(sigS2));

  const svc = new WarehouseService();
  const toS1 = await approvedTransfer(fx, fx.s1);
  const recv = await svc.completeTransfer(fx.storeId, toS1.id, fx.staff2A, [{ signerKind: "STAFF", imagePng: PNG }]);
  assert.equal(!recv.ok && recv.error.type, "forbidden");
  assert.equal(await level(fx, fx.wh), 20);

  const d1 = await people.saveDraft(fx.storeId, fx.staff2A, null, { flow: "COUNT", locationId: fx.s1, data: {} });
  assert.equal(!d1.ok && d1.error.type, "forbidden");
  const d2 = await people.saveDraft(fx.storeId, fx.staff2A, null, { flow: "COUNT", locationId: fx.s2, data: { lines: [] } });
  assert.equal(d2.ok, true);
  // The owner works everywhere.
  const d3 = await people.saveDraft(fx.storeId, fx.ownerA, null, { flow: "RELEASE", locationId: fx.s1, data: {} });
  assert.equal(d3.ok, true);
  // S2 staff's Tapusin list shows S2's draft, not S1's.
  const mine = await people.listDrafts(fx.storeId, fx.staff2A);
  assert.deepEqual(mine.map((d) => d.locationId), [fx.s2]);
  assert.equal((await people.listDrafts(fx.storeId, fx.ownerA)).length, 2);
  // And they cannot close S1's draft.
  const close = await people.closeDraft(fx.storeId, fx.staff2A, d3.ok ? d3.value.id : "", "CANCELLED");
  assert.equal(!close.ok && close.error.type, "forbidden");
});

test("M2: owner sets a home location; a location from another store is refused", async () => {
  const a = await fixture();
  const b = await fixture();
  const people = new PeopleService();
  const ok = await people.updateMember(a.storeId, a.staff2.id, { homeLocationId: a.s1 }, a.owner.id);
  assert.equal(ok.ok && ok.value.homeLocationId, a.s1);
  const cross = await people.updateMember(a.storeId, a.staff2.id, { homeLocationId: b.s1 }, a.owner.id);
  assert.equal(cross.ok, false);
  const clear = await people.updateMember(a.storeId, a.staff2.id, { homeLocationId: null }, a.owner.id);
  assert.equal(clear.ok && clear.value.homeLocationId, null);
  const notMember = await people.updateMember(a.storeId, b.staff2.id, { homeLocationId: a.s1 }, a.owner.id);
  assert.equal(!notMember.ok && notMember.error.type, "not_found", "store A cannot edit store B's people");
});

// ─────────────────────────────── PIN ───────────────────────────────

test("M2: 5 wrong PINs lock PIN login for 15 minutes; the owner can unlock", async () => {
  const fx = await fixture();
  const people = new PeopleService();
  const auth = new AuthService(new PrismaAuthRepository(), CONFIG);
  assert.equal((await people.updateMember(fx.storeId, fx.staff2.id, { pin: "1234" }, fx.owner.id)).ok, false, "weak PIN refused");
  assert.equal((await people.updateMember(fx.storeId, fx.staff2.id, { pin: "4829" }, fx.owner.id)).ok, true);
  const phone = fx.staff2.phone!;

  for (let i = 1; i <= 4; i++) {
    const r = await auth.pinLogin({ phone, pin: "0000" });
    assert.equal(!r.ok && r.error.type, "unauthorized", `try ${i}`);
    assert.match(msg(r), new RegExp(`${5 - i} tries left`));
  }
  const fifth = await auth.pinLogin({ phone, pin: "0000" });
  assert.equal(!fifth.ok && fifth.error.type, "rate_limited", "5th wrong PIN locks");
  const right = await auth.pinLogin({ phone, pin: "4829" });
  assert.equal(!right.ok && right.error.type, "rate_limited", "even the right PIN waits out the lock");
  const u = await prisma.user.findUniqueOrThrow({ where: { id: fx.staff2.id } });
  const mins = (u.pinLockedUntil!.getTime() - Date.now()) / 60_000;
  // The lock time comes from the database clock, "now" from this computer's clock: allow a minute of difference.
  assert.ok(mins > 14 && mins <= 16, `locked for ~15 minutes (got ${mins.toFixed(2)})`);

  assert.equal((await people.updateMember(fx.storeId, fx.staff2.id, { unlock: true }, fx.owner.id)).ok, true);
  const after = await auth.pinLogin({ phone, pin: "4829" });
  assert.equal(after.ok, true, msg(after));
  const claims = verifyToken(after.ok ? after.value.token : "", CONFIG);
  assert.equal(claims.sub, fx.staff2.id);
  assert.equal(claims.storeId, fx.storeId);
  assert.equal(typeof claims.tv, "number");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: fx.staff2.id } })).pinFailedCount, 0, "success resets the count");
});

test("M2: a burst of parallel PIN guesses gets at most 5 tries", async () => {
  const fx = await fixture();
  const auth = new AuthService(new PrismaAuthRepository(), CONFIG);
  await new PeopleService().updateMember(fx.storeId, fx.staff2.id, { pin: "4829" }, fx.owner.id);
  const guesses = ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010"];
  const results = await Promise.all(guesses.map((pin) => auth.pinLogin({ phone: fx.staff2.phone!, pin })));
  // Each try is reserved in one guarded UPDATE before the PIN is checked: 4 are told
  // "wrong", the 5th locks, and every other parallel guess never reaches the check.
  assert.equal(results.filter((r) => !r.ok && r.error.type === "unauthorized").length, 4);
  assert.equal(results.filter((r) => !r.ok && r.error.type === "rate_limited").length, 6);
  assert.equal(results.filter((r) => r.ok).length, 0);
});

test("M2: a new PIN from the owner signs the person out everywhere (token version)", async () => {
  const fx = await fixture();
  const before = (await prisma.user.findUniqueOrThrow({ where: { id: fx.staff2.id } })).tokenVersion;
  await new PeopleService().updateMember(fx.storeId, fx.staff2.id, { pin: "5827" }, fx.owner.id);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: fx.staff2.id } })).tokenVersion, before + 1);
});

test("M2: a person changes their own PIN by proving the current one", async () => {
  const fx = await fixture();
  const people = new PeopleService();
  await people.updateMember(fx.storeId, fx.staff2.id, { pin: "4829" }, fx.owner.id);
  assert.equal((await people.changeOwnPin(fx.staff2.id, "0000", "7351")).ok, false);
  assert.equal((await people.changeOwnPin(fx.staff2.id, "4829", "7351")).ok, true);
  const auth = new AuthService(new PrismaAuthRepository(), CONFIG);
  assert.equal((await auth.pinLogin({ phone: fx.staff2.phone!, pin: "7351" })).ok, true);
});

test("M2: unknown number and no-PIN accounts get the same answer", async () => {
  const fx = await fixture();
  const auth = new AuthService(new PrismaAuthRepository(), CONFIG);
  const a = await auth.pinLogin({ phone: "+639990000000", pin: "4829" });
  const b = await auth.pinLogin({ phone: fx.manager.phone!, pin: "4829" });
  assert.deepEqual(!a.ok && a.error, !b.ok && b.error);
});

// ─────────────────────────────── kargadors ───────────────────────────────

test("M2: kargadors — one name per store, only this store's active kargador can sign", async () => {
  const a = await fixture();
  const b = await fixture();
  const people = new PeopleService();
  const k = await people.saveKargador(a.storeId, null, { name: "Mang  Boy", phone: "09171234567", homeLocationId: a.s2 }, a.owner.id);
  assert.equal(k.ok, true, msg(k));
  const kid = k.ok ? k.value.id : "";
  assert.equal((await people.saveKargador(a.storeId, null, { name: "Mang Boy" }, a.owner.id)).ok, false, "duplicate name");
  assert.equal((await people.saveKargador(b.storeId, null, { name: "Mang Boy" }, b.owner.id)).ok, true, "another store may have its own Mang Boy");
  const row = await prisma.kargador.findUniqueOrThrow({ where: { id: kid } });
  assert.equal(row.name, "Mang Boy", "spaces tidied");
  assert.equal(row.phone, "+639171234567");

  const doc = { documentType: "TRANSFER", documentId: "t-k", step: "RELEASE", locationId: a.wh };
  const cross = await people.addSignatures(b.storeId, b.ownerA, { ...doc, locationId: b.wh }, [{ signerKind: "KARGADOR", kargadorId: kid, imagePng: PNG }]);
  assert.equal(cross.ok, false, "store B cannot use store A's kargador");
  assert.equal((await people.addSignatures(a.storeId, a.ownerA, doc, [{ signerKind: "KARGADOR", kargadorId: kid, imagePng: PNG }])).ok, true);
  await people.saveKargador(a.storeId, kid, { isActive: false }, a.owner.id);
  assert.equal((await people.addSignatures(a.storeId, a.ownerA, doc, [{ signerKind: "KARGADOR", kargadorId: kid, imagePng: PNG }])).ok, false, "inactive kargador cannot sign");
  assert.equal((await people.listKargadors(a.storeId)).length, 0);
  assert.equal((await people.listKargadors(a.storeId, true)).length, 1);
  assert.equal((await people.saveKargador(b.storeId, kid, { name: "Hijack" }, b.owner.id)).ok, false, "store B cannot edit store A's kargador");
});

// ─────────────────────────────── approvals ───────────────────────────────

test("M2: approvals — owner decides once, with their PIN; managers can't take the owner's call", async () => {
  const a = await fixture();
  const b = await fixture();
  const people = new PeopleService();
  await people.updateMember(a.storeId, a.owner.id, { pin: "8642" }, a.owner.id);
  await people.updateMember(a.storeId, a.manager.id, { pin: "9753" }, a.owner.id);
  const seen: string[] = [];
  registerApprovalHandler("LOSS_OVER_TOLERANCE", async (_tx, ap) => { seen.push(`${ap.documentId}:${ap.status}`); });

  const req = await prisma.$transaction((tx) => requestApproval(tx, {
    storeId: a.storeId, kind: "LOSS_OVER_TOLERANCE", documentType: "RESACK", documentId: "rsk-1", locationId: a.s1,
    summary: "Resack RSK-000001: kulang 0.5 kg (2%)", requestedById: a.manager.id,
  }));
  const again = await prisma.$transaction((tx) => requestApproval(tx, {
    storeId: a.storeId, kind: "LOSS_OVER_TOLERANCE", documentType: "RESACK", documentId: "rsk-1", summary: "dup", requestedById: a.manager.id,
  }));
  assert.equal(again.id, req.id, "one open question per document");
  assert.equal(again.created, false);
  assert.equal(await people.countPending(a.storeId, "OWNER"), 1);
  assert.equal(await people.countPending(a.storeId, "MANAGER"), 0, "loss approvals are the owner's");

  const byManager = await people.decideApproval(a.storeId, req.id, a.managerA, { decision: "APPROVE", pin: "9753" });
  assert.equal(!byManager.ok && byManager.error.type, "forbidden");
  const wrongPin = await people.decideApproval(a.storeId, req.id, a.ownerA, { decision: "APPROVE", pin: "0000" });
  assert.equal(!wrongPin.ok && wrongPin.error.type, "forbidden");
  const noReason = await people.decideApproval(a.storeId, req.id, a.ownerA, { decision: "DECLINE", pin: "8642" });
  assert.equal(noReason.ok, false, "a decline needs a reason");
  const crossStore = await people.decideApproval(b.storeId, req.id, b.ownerA, { decision: "APPROVE", pin: "8642" });
  assert.equal(!crossStore.ok && crossStore.error.type, "not_found", "store B cannot see store A's approval");
  assert.equal((await people.listApprovals(b.storeId, "ALL")).length, 0);

  const [x, y] = await Promise.all([
    people.decideApproval(a.storeId, req.id, a.ownerA, { decision: "APPROVE", pin: "8642", note: "ok" }),
    people.decideApproval(a.storeId, req.id, a.ownerA, { decision: "APPROVE", pin: "8642", note: "ok" }),
  ]);
  assert.equal([x.ok, y.ok].filter(Boolean).length, 1, "decided exactly once");
  assert.deepEqual(seen, ["rsk-1:APPROVED"], "the module's handler ran once, inside the decision");
  const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.id } });
  assert.equal(row.status, "APPROVED");
  assert.equal(row.decidedById, a.owner.id);
  assert.ok(await prisma.auditLog.findFirst({ where: { storeId: a.storeId, action: "approval.approved", entityId: req.id } }));
});

test("M2: a manager cannot approve their own request", async () => {
  const fx = await fixture();
  const people = new PeopleService();
  await people.updateMember(fx.storeId, fx.manager.id, { pin: "9753" }, fx.owner.id);
  const req = await prisma.$transaction((tx) => requestApproval(tx, {
    storeId: fx.storeId, kind: "VOID", documentType: "ORDER", documentId: "o-1", summary: "Void", requestedById: fx.manager.id,
  }));
  const r = await people.decideApproval(fx.storeId, req.id, fx.managerA, { decision: "APPROVE", pin: "9753" });
  assert.equal(!r.ok && r.error.type, "forbidden");
});

// ─────────────────────────────── numbering + drafts ───────────────────────────────

test("M2: document numbers never repeat, even when requested at the same moment", async () => {
  const fx = await fixture();
  const nums = await Promise.all(Array.from({ length: 8 }, () => prisma.$transaction((tx) => nextDocNumber(tx, fx.storeId, "REL"))));
  assert.deepEqual([...nums].sort(), ["REL-000001", "REL-000002", "REL-000003", "REL-000004", "REL-000005", "REL-000006", "REL-000007", "REL-000008"]);
  assert.equal(await prisma.$transaction((tx) => nextDocNumber(tx, fx.storeId, "TR")), "TR-000001", "each prefix counts on its own");
  const other = await fixture();
  assert.equal(await prisma.$transaction((tx) => nextDocNumber(tx, other.storeId, "REL")), "REL-000001", "each store counts on its own");
});

test("M2: drafts — saved each step, a stale copy cannot overwrite a newer one", async () => {
  const fx = await fixture();
  const people = new PeopleService();
  const d = await people.saveDraft(fx.storeId, fx.staff2A, null, { flow: "RELEASE", locationId: fx.s2, data: { qty: 1 } });
  assert.equal(d.ok, true);
  const id = d.ok ? d.value.id : "";
  const v2 = await people.saveDraft(fx.storeId, fx.staff2A, id, { step: 2, data: { qty: 2 }, version: 1 });
  assert.equal(v2.ok && v2.value.version, 2);
  const stale = await people.saveDraft(fx.storeId, fx.ownerA, id, { step: 2, data: { qty: 9 }, version: 1 });
  assert.equal(!stale.ok && stale.error.type, "conflict");
  assert.equal((await people.closeDraft(fx.storeId, fx.ownerA, id, "DONE")).ok, true, "another phone (the owner's) finishes it");
  assert.equal((await people.listDrafts(fx.storeId, fx.staff2A)).length, 0);
  assert.equal((await people.saveDraft(fx.storeId, fx.staff2A, null, { flow: "NOPE", data: {} })).ok, false);
  assert.equal((await people.saveDraft(fx.storeId, fx.staff2A, null, { flow: "COUNT", data: { big: "x".repeat(40_000) } })).ok, false);
});
