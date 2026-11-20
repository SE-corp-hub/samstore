// PIN lock: the PIN is kept as a hash the tablet can check offline; screen lists are cleaned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanScreenIds, lockPinMatches, newLockSecret, readFeatureLock } from "./feature-lock.js";

test("PIN lock: the right PIN matches, a wrong or badly shaped one does not", () => {
  const s = newLockSecret("4821");
  assert.equal(lockPinMatches(s, "4821"), true);
  assert.equal(lockPinMatches(s, "4822"), false);
  assert.equal(lockPinMatches(s, "48210"), false);
  assert.equal(lockPinMatches(s, ""), false);
  assert.notEqual(newLockSecret("4821").salt, s.salt); // a fresh salt each time
});

test("PIN lock: screen lists keep only short lowercase ids, once each", () => {
  assert.deepEqual(cleanScreenIds(["settings", "products", "settings", "<script>", 5, "Team"]), ["settings", "products"]);
  assert.equal(cleanScreenIds(undefined), null);
  assert.deepEqual(cleanScreenIds("settings"), []);
});

test("PIN lock: a broken stored value counts as no lock", () => {
  assert.equal(readFeatureLock(null), null);
  assert.equal(readFeatureLock({ salt: "x" }), null);
  const s = newLockSecret("1234");
  assert.deepEqual(readFeatureLock({ ...s, owner: ["settings"], staff: "x" })?.staff, []);
});

test("store PIN lock: owner and manager set any store, a head only its own, counter staff none", async () => {
  const { canSetLocationLock } = await import("./feature-lock.js");
  assert.equal(canSetLocationLock({ role: "OWNER", homeLocationId: null }, "lipa01"), true);
  assert.equal(canSetLocationLock({ role: "MANAGER", homeLocationId: null }, "lipa01"), true);
  assert.equal(canSetLocationLock({ role: "STAFF", homeLocationId: "lipa01", isHead: true }, "lipa01"), true);
  assert.equal(canSetLocationLock({ role: "STAFF", homeLocationId: "lipa01", isHead: true }, "bahay01"), false);
  assert.equal(canSetLocationLock({ role: "STAFF", homeLocationId: "lipa01", isHead: false }, "lipa01"), false);
  assert.equal(canSetLocationLock({ role: "SALES_AGENT", homeLocationId: null, isHead: true }, "lipa01"), false);
});

test("store PIN lock: kept beside the owner's lock, broken entries dropped, nothing left = null", async () => {
  const { readLocationLocks, writeFeatureLock } = await import("./feature-lock.js");
  const s = newLockSecret("2468");
  const raw = { ...newLockSecret("1111"), owner: [], staff: ["reports"], locations: { lipa0001: { ...s, screens: ["utangrice", "BAD"] }, "x": { ...s }, bahay0001: { salt: 1 } } };
  const locs = readLocationLocks(raw);
  assert.deepEqual(Object.keys(locs), ["lipa0001"]);
  assert.deepEqual(locs.lipa0001?.screens, ["utangrice"]);
  assert.equal(lockPinMatches(locs.lipa0001!, "2468"), true);
  // The owner's lock reads as before, with the stores' locks next to it.
  assert.deepEqual(readFeatureLock(raw)?.staff, ["reports"]);
  // Owner turns their lock off: the stores' locks stay.
  assert.deepEqual(Object.keys((writeFeatureLock(null, locs) as { locations: object }).locations), ["lipa0001"]);
  assert.equal(writeFeatureLock(null, {}), null);
});
