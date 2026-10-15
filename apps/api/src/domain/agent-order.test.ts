// Rice Ops M7 — agent order rules (pure, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentStatus, amountDue, checkAddress, readyToPay } from "./agent-order.js";

test("M7: the agent sees each status change", () => {
  const o = (status: string, declineReason: string | null = null) => ({ status, declineReason });
  assert.equal(agentStatus(o("RECEIVED"), []), "NAGHIHINTAY");
  assert.equal(agentStatus(o("CANCELLED", "Walang stock"), []), "TINANGGIHAN");
  assert.equal(agentStatus(o("CANCELLED"), []), "KINANSELA");
  assert.equal(agentStatus(o("CONFIRMED"), [{ status: "APPROVED", deliveredQty: null }]), "APRUBADO");
  assert.equal(agentStatus(o("CONFIRMED"), [{ status: "IN_TRANSIT", deliveredQty: null }, { status: "APPROVED", deliveredQty: null }]), "NAILABAS");
  assert.equal(agentStatus(o("CONFIRMED"), [{ status: "COMPLETED", deliveredQty: 2 }, { status: "RETURNING", deliveredQty: 0 }]), "NAIHATID");
  assert.equal(agentStatus(o("COMPLETED"), [{ status: "COMPLETED", deliveredQty: 2 }]), "BAYAD_NA");
});

test("M7: payment waits until every line is delivered (or cancelled)", () => {
  assert.equal(readyToPay([]), false);
  assert.equal(readyToPay([{ status: "IN_TRANSIT", deliveredQty: null }]), false);
  assert.equal(readyToPay([{ status: "COMPLETED", deliveredQty: 2 }, { status: "CANCELLED", deliveredQty: null }]), true);
});

test("M7: the customer pays for what was delivered", () => {
  const sack = { soldBy: "PIECE", unitPriceMinor: 130_000, quantity: 2, lineTotalMinor: 260_000 };
  const loose = { soldBy: "PESO", unitPriceMinor: 5_200, quantity: 1_923, lineTotalMinor: 10_000 };
  assert.equal(amountDue([{ ...sack, delivered: 2 }, { ...loose, delivered: 1_923 }]), 270_000);
  assert.equal(amountDue([{ ...sack, delivered: 1 }, { ...loose, delivered: 0 }]), 130_000, "1 of 2 sacks taken, loose refused");
});

test("M7: the address must be findable", () => {
  assert.equal(checkAddress("  Purok 3,  Brgy. San Isidro "), "Purok 3, Brgy. San Isidro");
  assert.throws(() => checkAddress("x"));
});
