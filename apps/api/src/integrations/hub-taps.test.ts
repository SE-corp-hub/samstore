import { test } from "node:test";
import assert from "node:assert/strict";
import { hubTapApplier, tapNote, tapSteps, type HubTap } from "./hub-taps.js";

test("a tap asks only for the steps the order still needs, and never confirms or revives one", () => {
  const steps = (status: string, tap: HubTap["status"]) => {
    const r = tapSteps(status, tap);
    return r.ok ? r.steps.join(">") || "nothing" : `refused: ${r.error}`;
  };
  // On the way.
  assert.equal(steps("CONFIRMED", "OUT_FOR_DELIVERY"), "send");
  assert.equal(steps("PREPARING", "OUT_FOR_DELIVERY"), "send");
  assert.equal(steps("READY", "OUT_FOR_DELIVERY"), "send");
  assert.equal(steps("FAILED_DELIVERY", "OUT_FOR_DELIVERY"), "retry");
  assert.equal(steps("OUT_FOR_DELIVERY", "OUT_FOR_DELIVERY"), "nothing", "the same tap twice changes nothing");
  assert.equal(steps("DELIVERED", "OUT_FOR_DELIVERY"), "nothing", "a late tap never takes a delivered order back");
  // Delivered.
  assert.equal(steps("OUT_FOR_DELIVERY", "DELIVERED"), "deliver");
  assert.equal(steps("READY", "DELIVERED"), "send>deliver", "delivered without tapping On the way first");
  assert.equal(steps("FAILED_DELIVERY", "DELIVERED"), "retry>deliver");
  assert.equal(steps("DELIVERED", "DELIVERED"), "nothing");
  assert.equal(steps("COMPLETED", "DELIVERED"), "nothing");
  // Not the delivery team's to decide.
  assert.match(steps("RECEIVED", "DELIVERED"), /^refused: Sam Store has not confirmed this order yet/);
  assert.match(steps("CANCELLED", "DELIVERED"), /^refused: This order is cancelled in Sam Store/);
  assert.match(steps("ON_HOLD", "OUT_FOR_DELIVERY"), /^refused: This order is on hold in Sam Store/);
  // The hub's Confirm button: it confirms a new order and nothing else.
  assert.equal(steps("RECEIVED", "CONFIRMED"), "confirm");
  assert.equal(steps("CONFIRMED", "CONFIRMED"), "nothing", "the same tap twice changes nothing");
  assert.equal(steps("OUT_FOR_DELIVERY", "CONFIRMED"), "nothing", "a late Confirm never takes an order back");
  assert.equal(steps("DELIVERED", "CONFIRMED"), "nothing");
  assert.match(steps("CANCELLED", "CONFIRMED"), /^refused: This order is cancelled in Sam Store/);
});

test("the hub's Confirm tap confirms the store's own new order, with who tapped", async () => {
  const calls: string[] = [];
  let status = "RECEIVED";
  const apply = hubTapApplier(
    async (storeId, orderNumber) => (storeId === "store-1" && orderNumber === "LIPA-000004" ? { id: "o1", status } : null),
    {
      sendForDelivery: async () => ({ ok: false, error: { type: "conflict", message: "not used here" } }),
      transition: async (storeId, orderId, to, reason) => {
        calls.push(`${to} ${storeId} ${orderId} "${reason}"`);
        status = to;
        return { ok: true, value: { id: orderId, status: to } };
      },
    },
    {
      retryDelivery: async () => ({ ok: false, error: { type: "conflict", message: "not used here" } }),
      markStatus: async () => ({ ok: false, error: { type: "conflict", message: "not used here" } }),
    },
  );
  const tap: HubTap = { orderNumber: "LIPA-000004", status: "CONFIRMED", by: "lea" };
  assert.equal(await apply("store-1", tap), null);
  assert.deepEqual(calls, ['CONFIRMED store-1 o1 "Confirmed in the hub by lea"']);
  // Offered again (our answer was lost): nothing more happens.
  assert.equal(await apply("store-1", tap), null);
  assert.equal(calls.length, 1);
  assert.equal(await apply("store-2", tap), "Sam Store has no hub order with this number");
});

test("the applier walks the store's own hub order through the steps, with the cash and who tapped", async () => {
  const calls: string[] = [];
  let status = "READY";
  const apply = hubTapApplier(
    async (storeId, orderNumber) => (storeId === "store-1" && orderNumber === "SAMSTO-000031" ? { id: "o1", status } : null),
    {
      sendForDelivery: async (storeId, orderId, note) => {
        calls.push(`send ${storeId} ${orderId} "${note}"`);
        status = "OUT_FOR_DELIVERY";
        return { ok: true, value: { id: orderId, status } };
      },
      transition: async () => ({ ok: false, error: { type: "conflict", message: "not used here" } }),
    },
    {
      retryDelivery: async () => ({ ok: false, error: { type: "conflict", message: "not used here" } }),
      markStatus: async (storeId, orderId, to, _reason, proof) => {
        if (status !== "OUT_FOR_DELIVERY") return { ok: false, error: { type: "conflict", message: `Cannot update an order in ${status}` } };
        calls.push(`${to} ${storeId} ${orderId} cash=${proof?.cashCollectedMinor} actor=${proof?.actor?.userId} "${proof?.via}"`);
        status = "DELIVERED";
        return { ok: true, value: { id: orderId, status, paymentStatus: "COLLECTED" } };
      },
    },
  );
  const tap: HubTap = { orderNumber: "SAMSTO-000031", status: "DELIVERED", by: "rey", cashMinor: 290000 };
  assert.equal(await apply("store-1", tap), null);
  assert.deepEqual(calls, [
    'send store-1 o1 "Tapped Delivered in the hub by rey"',
    'DELIVERED store-1 o1 cash=290000 actor=undefined "Tapped Delivered in the hub by rey"',
  ]);
  // Offered again (our answer was lost): nothing more happens.
  assert.equal(await apply("store-1", tap), null);
  assert.equal(calls.length, 2);
  // Another store's number, or one the hub never handed over, is not found.
  assert.equal(await apply("store-2", tap), "Sam Store has no hub order with this number");
  // A step the store's own rules refuse comes back in their words.
  status = "FAILED_DELIVERY";
  assert.equal(await apply("store-1", { orderNumber: "SAMSTO-000031", status: "OUT_FOR_DELIVERY" }), "not used here");
  assert.equal(tapNote({ status: "OUT_FOR_DELIVERY" }), "Tapped On the way in the hub");
});
