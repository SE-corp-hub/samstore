// Rice Ops M6 — utang rules and texts (pure, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import { creditStatus,
  checkPayment, daysSince, itemsText, limitCheck, monthKey, monthlyText, overdueText, paymentText, pesoText, refundValue,
  saleText, shortDate, smsSegments, UtangError, weekKey,
} from "./utang.js";

test("M6: money reads like people write it; texts use P (one SMS, not two)", () => {
  assert.equal(pesoText(125_000), "₱1,250");
  assert.equal(pesoText(125_050), "₱1,250.50");
  assert.equal(pesoText(-2_000), "-₱20");
  assert.equal(pesoText(125_000, "P"), "P1,250");
});

test("M6: dates are Manila days — 11:30 pm UTC on the 13th is already the 14th", () => {
  assert.equal(shortDate(new Date("2026-10-13T16:30:00Z")), "14 Okt");
  assert.equal(shortDate(new Date("2026-01-01T00:00:00+08:00")), "1 Ene");
});

test("M6: the utang sale text carries the amount and the new balance", () => {
  const t = saleText({ customerName: "Juan Dela Cruz", amountMinor: 125_000, items: ["Sinandomeng 25kg"], locationName: "Store 1", at: new Date("2026-10-14T03:00:00Z"), balanceMinor: 340_000 });
  assert.equal(t, "Salamat po, Juan. Utang ngayon: P1,250 (Sinandomeng 25kg, Store 1, 14 Okt). Kabuuang utang: P3,400.");
  assert.equal(smsSegments(t), 1, "fits one SMS");
  assert.equal(itemsText(["A", "B", "B", "C"]), "A +2 pa");
});

test("M6: the payment text shows what is left — or that it is all paid", () => {
  assert.equal(paymentText({ amountMinor: 100_000, balanceMinor: 240_000 }), "Natanggap: P1,000. Natitirang utang: P2,400. Salamat po!");
  assert.equal(paymentText({ amountMinor: 50_000, balanceMinor: 0 }), "Natanggap: P500. Bayad na po lahat ng utang. Salamat po!");
  assert.match(monthlyText({ customerName: "Ana", balanceMinor: 99_950, storeName: "Bigasan ni Nena", at: new Date("2026-11-01T01:00:00Z") }), /P999\.50/);
  assert.match(overdueText({ customerName: "Ana", balanceMinor: 1_000, days: 31, storeName: "S", }), /31 araw/);
});

test("M6: the limit — at the limit is fine, one centavo over goes to the owner", () => {
  assert.deepEqual(limitCheck(400_000, 100_000, 500_000), { ok: true });
  assert.deepEqual(limitCheck(400_000, 100_001, 500_000), { ok: false, overByMinor: 1 });
  assert.deepEqual(limitCheck(0, 100, 0), { ok: false, overByMinor: 100 }, "no limit set = every utang needs the owner");
  assert.throws(() => limitCheck(0, 0, 100), UtangError);
});

test("M6: Bayad sa utang — partial is fine, more than owed is refused", () => {
  assert.equal(checkPayment(240_000, 100_000), 100_000);
  assert.equal(checkPayment(240_000, 240_000), 240_000);
  assert.throws(() => checkPayment(240_000, 240_001), /Too much — the customer only owes ₱2,400/);
  assert.throws(() => checkPayment(0, 100), /owes nothing/);
  assert.throws(() => checkPayment(100, 1.5), UtangError);
});

test("M6: reminder periods — one per month, one per week, in Manila time", () => {
  assert.equal(monthKey(new Date("2026-10-31T16:30:00Z")), "M2026-11", "already November in Manila");
  assert.equal(weekKey(new Date("2026-10-12T01:00:00Z")), weekKey(new Date("2026-10-18T10:00:00Z")), "Mon–Sun is one week");
  assert.notEqual(weekKey(new Date("2026-10-18T10:00:00Z")), weekKey(new Date("2026-10-19T01:00:00Z")));
  assert.equal(daysSince(new Date("2026-09-14T03:00:00Z"), new Date("2026-10-14T03:00:00Z")), 30);
});

test("M6: returned rice is valued at what it sold for", () => {
  assert.equal(refundValue({ soldBy: "PIECE", unitPriceMinor: 130_000, quantity: 2, lineTotalMinor: 260_000 }, 1), 130_000);
  assert.equal(refundValue({ soldBy: "PIECE", unitPriceMinor: 130_000, quantity: 2, lineTotalMinor: 260_000 }, 5), 260_000, "never more than the line");
  assert.equal(refundValue({ soldBy: "PESO", unitPriceMinor: 5_200, quantity: 1_923, lineTotalMinor: 10_000 }, 1_923), 10_000, "the whole by-peso line = the pesos paid");
  assert.equal(refundValue({ soldBy: "KILO", unitPriceMinor: 5_200, quantity: 2_000, lineTotalMinor: 10_400 }, 500), 2_600);
  assert.equal(refundValue({ soldBy: null, unitPriceMinor: 100, quantity: 1, lineTotalMinor: 100 }, 0), 0);
});

test("credit status: no credit, no limit, OK, near (80%+), at the limit; available is what is left", () => {
  assert.deepEqual(creditStatus({ approved: false, unlimited: false, limitMinor: 0, balanceMinor: 0 }), { status: "NO_CREDIT", availableMinor: 0 });
  assert.deepEqual(creditStatus({ approved: true, unlimited: true, limitMinor: null, balanceMinor: 900_000 }), { status: "NO_LIMIT", availableMinor: null });
  assert.deepEqual(creditStatus({ approved: true, unlimited: false, limitMinor: 100_000, balanceMinor: 50_000 }), { status: "OK", availableMinor: 50_000 });
  assert.deepEqual(creditStatus({ approved: true, unlimited: false, limitMinor: 100_000, balanceMinor: 80_000 }), { status: "NEAR_LIMIT", availableMinor: 20_000 });
  assert.deepEqual(creditStatus({ approved: true, unlimited: false, limitMinor: 100_000, balanceMinor: 100_000 }), { status: "AT_LIMIT", availableMinor: 0 });
  assert.deepEqual(creditStatus({ approved: true, unlimited: false, limitMinor: 100_000, balanceMinor: 120_000 }), { status: "AT_LIMIT", availableMinor: 0 });
});
