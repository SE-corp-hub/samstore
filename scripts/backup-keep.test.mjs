import test from "node:test";
import assert from "node:assert/strict";
import { pickToDelete, backupTime } from "./backup-keep.mjs";

const day = (y, m, d, hm = "2100") => `samstore-${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}-${hm}.dump`;

test("a few backups: nothing is deleted", () => {
  const names = [day(2026, 10, 20), day(2026, 10, 21), day(2026, 10, 22)];
  assert.deepEqual(pickToDelete(names), []);
});

test("keeps the newest 14, deletes older ones that are not the newest of their month", () => {
  const names = [];
  for (let d = 1; d <= 28; d++) names.push(day(2026, 10, d));
  const del = pickToDelete(names);
  // 28 files; newest 14 are 15..28; the newest of October (28) is already kept
  assert.equal(del.length, 14);
  assert.ok(!del.includes(day(2026, 10, 15)));
  assert.ok(del.includes(day(2026, 10, 14)));
  assert.ok(del.includes(day(2026, 10, 1)));
});

test("keeps the newest backup of each of the last 6 months", () => {
  const names = [];
  for (let m = 1; m <= 10; m++) for (const d of [5, 25]) names.push(day(2026, m, d));
  const del = pickToDelete(names, { keepNewest: 2 });
  // newest 2 = Oct 25, Oct 5. Monthly keepers: Oct 25, Sep 25, Aug 25, Jul 25, Jun 25, May 25.
  const kept = names.filter((n) => !del.includes(n));
  assert.deepEqual(kept.sort(), [day(2026, 5, 25), day(2026, 6, 25), day(2026, 7, 25), day(2026, 8, 25), day(2026, 9, 25), day(2026, 10, 5), day(2026, 10, 25)].sort());
});

test("two backups the same day: the later one is the newest", () => {
  const names = [day(2026, 10, 22, "0200"), day(2026, 10, 22, "2100")];
  assert.deepEqual(pickToDelete(names, { keepNewest: 1, keepMonths: 1 }), [day(2026, 10, 22, "0200")]);
});

test("files that are not backups are never listed", () => {
  const names = ["notes.txt", "backup-log.txt", "samstore-latest.dump", "samstore-20261022-2100.dump.part", day(2026, 10, 1)];
  assert.deepEqual(pickToDelete(names, { keepNewest: 0, keepMonths: 0 }), [day(2026, 10, 1)]);
});

test("backupTime reads the stamp", () => {
  assert.equal(backupTime("samstore-20261022-2130.dump"), "2026-10-22 21:30");
  assert.equal(backupTime("other.dump"), null);
});
