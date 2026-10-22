import test from "node:test";
import assert from "node:assert/strict";
import { asksRecount, checkReason, cleanNote, missingReasons, missingReasonsMessage, OVER_REASONS, reasonsFor, REASON_LABEL, SHORT_REASONS } from "./count-reasons.js";

test("short and over have their own reasons, and 'Don't know' is always there", () => {
  assert.equal(reasonsFor(-1).includes("UNRINGED"), true);
  assert.equal(reasonsFor(-1).includes("STOCKIN_MISSING"), false);
  assert.equal(reasonsFor(3).includes("STOCKIN_MISSING"), true);
  assert.equal(reasonsFor(3).includes("SPILLED"), false);
  assert.deepEqual(reasonsFor(0), []);
  assert.equal(SHORT_REASONS.includes("UNKNOWN") && OVER_REASONS.includes("UNKNOWN"), true);
  for (const r of [...SHORT_REASONS, ...OVER_REASONS]) assert.ok(REASON_LABEL[r], `${r} has a label`);
});

test("a reason must fit the direction; a correct item takes none", () => {
  assert.equal(checkReason(-2, "WEEVILS"), "WEEVILS");
  assert.equal(checkReason(2, "MOVED_IN"), "MOVED_IN");
  assert.equal(checkReason(2, "OPENED_SACK"), "OPENED_SACK", "an opened sack can be short (the sack) or over (the loose rice)");
  assert.throws(() => checkReason(-2, "STOCKIN_MISSING"), /why it is short/);
  assert.throws(() => checkReason(2, "SPILLED"), /why it is over/);
  assert.throws(() => checkReason(2, undefined), /why it is over/);
  assert.throws(() => checkReason(0, "UNKNOWN"), /correct/);
  assert.throws(() => checkReason(-1, "nonsense"), /why it is short/);
});

test("notes are trimmed and short", () => {
  assert.equal(cleanNote("  sack   split in the back "), "sack split in the back");
  assert.equal(cleanNote("   "), null);
  assert.equal(cleanNote(42), null);
  assert.equal(cleanNote("x".repeat(300))!.length, 120);
});

test("a big difference asks to be counted again, once", () => {
  assert.equal(asksRecount(-50_000, 50_000, false), true, "exactly the limit counts");
  assert.equal(asksRecount(60_000, 50_000, false), true, "over counts too");
  assert.equal(asksRecount(-49_999, 50_000, false), false);
  assert.equal(asksRecount(-90_000, 50_000, true), false, "already counted again");
  assert.equal(asksRecount(-90_000, 0, false), false, "a limit of 0 switches it off");
});

test("submit needs a valid reason on every difference, and says which", () => {
  const lines = [
    { name: "Sin 25", varianceQty: -1, reason: "SPILLED" },
    { name: "Din 25", varianceQty: 0, reason: null },
    { name: "Jas 25", varianceQty: -2, reason: null },
    { name: "Loose", varianceQty: 400, reason: "SPILLED" }, // a "short" reason on an over line is not valid
  ];
  assert.deepEqual(missingReasons(lines).map((l) => l.name), ["Jas 25", "Loose"]);
  assert.equal(missingReasonsMessage(["A", "B", "C", "D", "E"]), "Choose a reason for: A, B, C +2 more");
  assert.equal(missingReasonsMessage(["A"]), "Choose a reason for: A");
});
