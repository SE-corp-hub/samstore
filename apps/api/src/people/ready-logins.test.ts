// Per-store build, step 8 — logins that can be handed over, against the real DB.
//   * the owner makes a ready login for a store: a sign-in name and a temporary password that must
//     be changed at the first sign-in;
//   * handing it over writes the person's name and mobile, gives a new temporary password, removes
//     the old PIN and signs the old holder out; it can be handed over once;
//   * the owner corrects a login's name or mobile, never to a number another login uses.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { prisma } from "../persistence/prisma-repositories.js";
import { PeopleService } from "./people.service.js";

const run = `rdy${Date.now()}${Math.floor(Math.random() * 1000)}`;
const storeIds: string[] = [];
const userIds: string[] = [];
let seq = 0;
const people = new PeopleService();

after(async () => {
  if (storeIds.length) {
    const where = { storeId: { in: storeIds } };
    const members = await prisma.userStore.findMany({ where, select: { userId: true } });
    userIds.push(...members.map((m) => m.userId));
    await prisma.auditLog.deleteMany({ where });
    await prisma.passwordResetHistory.deleteMany({ where });
    await prisma.userStore.deleteMany({ where });
    await prisma.storeSettings.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function fixture() {
  seq += 1;
  const store = await prisma.store.create({ data: { slug: `${run}-${seq}`, name: `Ready ${seq}` } });
  storeIds.push(store.id);
  await prisma.storeSettings.create({ data: { storeId: store.id, requireOpenShift: false } });
  await prisma.warehouse.create({ data: { storeId: store.id, name: "Bogs and Lucy", code: "S1", type: "STORE", isDefault: true } });
  const lipa = await prisma.warehouse.create({ data: { storeId: store.id, name: "Lipa", code: "S3", type: "STORE", consignment: true } });
  const owner = await prisma.user.create({ data: { email: `${run}-${seq}-owner@rdy.test`, passwordHash: "x", name: "Owner", role: "STORE_OWNER" } });
  await prisma.userStore.create({ data: { userId: owner.id, storeId: store.id, role: "OWNER" } });
  return { storeId: store.id, slug: store.slug, lipa: lipa.id, owner: owner.id };
}
const must = <T,>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
// A mobile number no other test run uses.
const mobile = () => `0917${String(Date.now() + seq * 7919).slice(-7)}`;

test("the owner makes a ready login and hands it over once", async () => {
  const fx = await fixture();
  assert.equal((await people.createReadyLogin(fx.storeId, { label: "Lipa head" }, fx.owner)).ok, false, "a ready login needs its store");
  const made = must(await people.createReadyLogin(fx.storeId, { label: "  Lipa   head ", homeLocationId: fx.lipa, isLocationHead: true }, fx.owner));
  assert.equal(made.label, "Lipa head");
  assert.equal(made.signInName, `lipa-head@${fx.slug}`);
  assert.match(made.tempPassword, /^[a-z]{4}-[2-9]{4}-[a-z]{4}$/);
  assert.equal((await people.createReadyLogin(fx.storeId, { label: "lipa HEAD", homeLocationId: fx.lipa }, fx.owner)).ok, false, "the same name twice is refused");

  const u = await prisma.user.findUniqueOrThrow({ where: { id: made.userId } });
  assert.equal(u.mustChangePassword, true, "the password is changed at the first sign-in");
  assert.equal(await bcrypt.compare(made.tempPassword, u.passwordHash), true);
  const row = (await people.listMembers(fx.storeId)).find((m) => m.userId === made.userId)!;
  assert.deepEqual({ readyLabel: row.readyLabel, home: row.homeLocationId, head: row.isLocationHead, role: row.role }, { readyLabel: "Lipa head", home: fx.lipa, head: true, role: "STAFF" });

  // Someone used it for a while and set a PIN; then it goes to the real person.
  await prisma.user.update({ where: { id: made.userId }, data: { pinHash: "old-pin", mustChangePassword: false } });
  assert.equal((await people.handOverLogin(fx.storeId, made.userId, { name: " " }, fx.owner)).ok, false, "a name is needed");
  const phone = mobile();
  const given = must(await people.handOverLogin(fx.storeId, made.userId, { name: "Maria Santos", phone }, fx.owner));
  assert.equal(given.name, "Maria Santos");
  assert.match(given.signInWith, /^\+63917/);
  assert.notEqual(given.tempPassword, made.tempPassword);
  const after = await prisma.user.findUniqueOrThrow({ where: { id: made.userId } });
  assert.equal(after.name, "Maria Santos");
  assert.equal(after.pinHash, null, "the old PIN is gone");
  assert.equal(after.mustChangePassword, true);
  assert.equal(after.tokenVersion, u.tokenVersion + 1, "the old holder is signed out");
  assert.equal(await bcrypt.compare(made.tempPassword, after.passwordHash), false, "the old password no longer works");
  const rowAfter = (await people.listMembers(fx.storeId)).find((m) => m.userId === made.userId)!;
  assert.equal(rowAfter.readyLabel, null);
  assert.equal(rowAfter.isLocationHead, true, "it keeps its store and its head tick");

  const again = await people.handOverLogin(fx.storeId, made.userId, { name: "Someone Else" }, fx.owner);
  assert.equal(again.ok, false, "handed over once");
});

test("the owner corrects a login's name and mobile", async () => {
  const fx = await fixture();
  const a = must(await people.createReadyLogin(fx.storeId, { label: "Lipa counter", homeLocationId: fx.lipa }, fx.owner));
  const b = must(await people.createReadyLogin(fx.storeId, { label: "Lipa counter 2", homeLocationId: fx.lipa }, fx.owner));
  const phone = mobile();
  const edited = must(await people.editPerson(fx.storeId, a.userId, { name: "Ana Reyes", phone }, fx.owner));
  assert.equal(edited.name, "Ana Reyes");
  assert.match(edited.phone ?? "", /^\+63917/);
  const clash = await people.editPerson(fx.storeId, b.userId, { phone }, fx.owner);
  assert.equal(clash.ok, false, "a number another login uses is refused");
  assert.equal((await people.editPerson(fx.storeId, a.userId, { phone: "12345" }, fx.owner)).ok, false);
  assert.equal((await people.editPerson(fx.storeId, fx.owner, { name: "New Owner" }, fx.owner)).ok, false, "not the owner's own login");
  // Editing does not change the password or sign anyone out.
  const u = await prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
  assert.equal(await bcrypt.compare(a.tempPassword, u.passwordHash), true);
  assert.equal(u.tokenVersion, 0);
});
