// Rice Ops M3 — trip rules (pure, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoApproves, checkArrival, checkRelease, checkReturnBack, deliveryOutcome, readBack, receiveOutcome, returnOutcome,
} from "./transfer-flow.js";

test("M3 lipat: a request from the warehouse is approved at once; store-to-store waits", () => {
  assert.equal(autoApproves("WAREHOUSE"), true);
  assert.equal(autoApproves("STORE"), false);
});

test("M3 ilabas: release between 1 and what was asked for", () => {
  assert.equal(checkRelease(20, 20).ok, true);
  assert.equal(checkRelease(20, 19).ok, true, "can send fewer than asked");
  assert.equal(checkRelease(20, 21).ok, false);
  assert.equal(checkRelease(20, 0).ok, false, "releasing nothing is a cancel, not a release");
  assert.equal(checkRelease(20, 2.5).ok, false);
  assert.equal(checkRelease(20, "5").ok, false);
});

test("M3 tanggapin: 19 of 20 received → 1 short on the trip", () => {
  assert.equal(checkArrival(20, 19).ok, true);
  assert.deepEqual(receiveOutcome(20, 19), { short: 1 });
  assert.deepEqual(receiveOutcome(20, 20), { short: 0 });
  assert.equal(checkArrival(20, 21).ok, false, "more cannot arrive than left");
  assert.equal(checkArrival(20, -1).ok, false);
  assert.equal(checkArrival(20, 0).ok, true, "everything lost is still a count");
});

test("M3 naihatid: refused or partial delivery sends the rest back", () => {
  assert.deepEqual(deliveryOutcome(2, 2), { pendingReturn: 0, nextStatus: "COMPLETED" });
  assert.deepEqual(deliveryOutcome(2, 1), { pendingReturn: 1, nextStatus: "RETURNING" });
  assert.deepEqual(deliveryOutcome(2, 0), { pendingReturn: 2, nextStatus: "RETURNING" }, "refused delivery");
});

test("M3 tanggapin pabalik: the return is counted; anything missing is short", () => {
  assert.equal(checkReturnBack(2, 2).ok, true);
  assert.equal(checkReturnBack(2, 3).ok, false);
  assert.deepEqual(returnOutcome(2, 1), { short: 1 });
});

test("M3 read-back sentences name the rice, the places and the kargador", () => {
  assert.equal(
    readBack("RELEASE", { qty: 2, product: "Sinandomeng 25 kg", from: "Store 2", to: "Store 1", kargador: "Mang Boy", customer: "Juan" }),
    "Ilalabas: 2 × Sinandomeng 25 kg mula Store 2, dala ni Mang Boy, para sa customer (Juan).",
  );
  assert.equal(
    readBack("RECEIVE", { qty: 19, product: "Dinorado 25 kg", from: "Warehouse", to: "Store 1", kargador: "Mang Boy" }),
    "Tatanggapin sa Store 1: 19 × Dinorado 25 kg galing Warehouse, dala ni Mang Boy.",
  );
});
