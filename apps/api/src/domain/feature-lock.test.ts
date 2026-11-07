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
