// Rice Ops M2 — pure rules for PINs, locations, signatures, numbering, approvals, drafts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canActAtLocation, canDecide, checkSignatureImage, formatDocNumber, isDraftStale, missingMessage,
  missingSigners, pinLockSecondsLeft, pinProblem, requiredSigners,
} from "./people.js";

// Smallest valid PNG (1×1 white pixel).
export const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

test("M2 PIN: 4 digits, no repeats or runs", () => {
  assert.equal(pinProblem("4829"), null);
  assert.equal(pinProblem("0712"), null);
  for (const bad of ["123", "12345", "12a4", "", undefined, 1234, "1111", "1234", "4321", "6789", "0000"]) {
    assert.notEqual(pinProblem(bad), null, `${String(bad)} must be refused`);
  }
});

test("M2 PIN: lock countdown", () => {
  const now = new Date("2026-10-14T08:00:00Z");
  assert.equal(pinLockSecondsLeft(null, now), 0);
  assert.equal(pinLockSecondsLeft(new Date("2026-10-14T07:59:00Z"), now), 0);
  assert.equal(pinLockSecondsLeft(new Date("2026-10-14T08:15:00Z"), now), 900);
});

test("M2 location: S2 staff cannot act for S1; owner, manager and unassigned staff can", () => {
  assert.equal(canActAtLocation("STAFF", "S2", "S1"), false);
  assert.equal(canActAtLocation("STAFF", "S2", "S2"), true);
  assert.equal(canActAtLocation("STAFF", "S2", null), false, "a staff member with a home location must name a location");
  assert.equal(canActAtLocation("STAFF", null, "S1"), true, "no home location = every location");
  assert.equal(canActAtLocation("OWNER", "S2", "S1"), true);
  assert.equal(canActAtLocation("MANAGER", "S2", "S1"), true);
  assert.equal(canActAtLocation("SALES_AGENT", "S2", "S1"), false);
});

test("M2 signatures: a step without its signatures is refused", () => {
  assert.deepEqual(missingSigners("TRANSFER", "RECEIVE", []), ["STAFF"]);
  assert.deepEqual(missingSigners("TRANSFER", "RECEIVE", [{ signerKind: "STAFF" }]), []);
  assert.deepEqual(missingSigners("TRANSFER", "RECEIVE", [{ signerKind: "STAFF" }], { kargador: true }), ["KARGADOR"]);
  assert.deepEqual(missingSigners("RELEASE", "DELIVERED", [{ signerKind: "STAFF" }], { customer: true }), ["KARGADOR", "CUSTOMER"]);
  assert.deepEqual(missingSigners("PAPER_SLIP", "ENCODE", [{ signerKind: "STAFF" }]), ["SLIP_PHOTO"]);
  assert.equal(missingMessage(["STAFF", "KARGADOR"]), "Kulang ang pirma: staff, kargador");
});

test("M2 signatures: an unknown step fails closed", () => {
  assert.equal(requiredSigners("TRANSFER", "TELEPORT"), null);
  assert.deepEqual(missingSigners("TRANSFER", "TELEPORT", [{ signerKind: "STAFF" }, { signerKind: "KARGADOR" }]), ["STAFF"]);
});

test("M2 signatures: only a real PNG data URL is accepted", () => {
  const ok = checkSignatureImage(TINY_PNG);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.sha256.length, 64);
  assert.equal(checkSignatureImage("data:image/jpeg;base64,AAAA").ok, false);
  assert.equal(checkSignatureImage("data:image/png;base64,PHN2Zz4=").ok, false, "not PNG bytes");
  assert.equal(checkSignatureImage("data:image/png;base64,<script>").ok, false);
  assert.equal(checkSignatureImage(null).ok, false);
  const huge = "data:image/png;base64," + Buffer.alloc(200_000, 1).toString("base64");
  assert.equal(checkSignatureImage(huge).ok, false);
});

test("M2 numbering: REL-000123 style", () => {
  assert.equal(formatDocNumber("REL", 123), "REL-000123");
  assert.equal(formatDocNumber("CNT", 45), "CNT-000045");
  assert.equal(formatDocNumber("TR", 1_234_567), "TR-1234567");
  assert.throws(() => formatDocNumber("WO", 0));
});

test("M2 approvals: who may decide", () => {
  assert.equal(canDecide("OWNER", ["OWNER"], false).ok, true);
  assert.equal(canDecide("MANAGER", ["OWNER"], false).ok, false, "loss over 1% is the owner's call");
  assert.equal(canDecide("MANAGER", ["OWNER", "MANAGER"], true).ok, false, "no approving your own request");
  assert.equal(canDecide("OWNER", ["OWNER", "MANAGER"], true).ok, true);
  assert.equal(canDecide("STAFF", ["OWNER", "MANAGER"], false).ok, false);
  assert.equal(canDecide("PLATFORM_ADMIN", ["OWNER"], false).ok, false);
});

test("M2 drafts: stale after 2 hours", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  assert.equal(isDraftStale(new Date("2026-10-14T10:30:00Z"), now), false);
  assert.equal(isDraftStale(new Date("2026-10-14T09:59:00Z"), now), true);
});
