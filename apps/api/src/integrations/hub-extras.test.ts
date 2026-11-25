import { test } from "node:test";
import assert from "node:assert/strict";
import { hubOrderCost, hubPriceReason, phoneKey, priceChangeLines } from "./hub-extras.js";

test("a mobile number is the same person however it was typed", () => {
  assert.equal(phoneKey("0917 123 4567"), "9171234567");
  assert.equal(phoneKey("+63 (917) 123-4567"), "9171234567");
  assert.equal(phoneKey("9171234567"), "9171234567");
  assert.equal(phoneKey("12345"), "", "too short to be anyone");
  assert.equal(phoneKey(null), "");
});

test("an order's cost is the cost frozen on each line, else the item's cost today; unknown when any line has none", () => {
  const line = (over: Partial<Parameters<typeof hubOrderCost>[0][number]> = {}) => ({ quantity: 2, grams: null, soldBy: null, unitCostMinor: 120000, product: { costMinor: 125000 }, ...over });
  assert.equal(hubOrderCost([line()]), 240000, "the cost when it was sold, not today's");
  assert.equal(hubOrderCost([line({ unitCostMinor: null })]), 250000, "not handed over yet: the item's cost today");
  assert.equal(hubOrderCost([line(), line({ quantity: 1, unitCostMinor: 100000 })]), 340000);
  assert.equal(hubOrderCost([line({ soldBy: "KILO", grams: 2500, quantity: 2500, unitCostMinor: 5000 })]), 12500, "a kilo line's cost is per kilo");
  assert.equal(hubOrderCost([line(), line({ unitCostMinor: null, product: { costMinor: 0 } })]), null, "one line with no cost: say not known, not a profit that reads too high");
  assert.equal(hubOrderCost([line({ unitCostMinor: null, product: null })]), null);
});

test("the words kept on a changed price: why, then who, and never longer than a reason may be", () => {
  assert.equal(hubPriceReason("Suki, pays cash", "owner"), "Suki, pays cash (owner, SE Corp Hub)");
  assert.equal(hubPriceReason(undefined, undefined), "Price given on the Page (SE Corp Hub)");
  const long = hubPriceReason("x".repeat(300), "lea");
  assert.equal(long.length, 140);
  assert.match(long, /\(lea, SE Corp Hub\)$/);
});

test("a price change keeps every other line at the price it was sold at, and a price changed before keeps its reason", () => {
  const lines = [
    { productId: "p1", productName: "Samrice Dinorado 25kg", sku: "DINO-25", quantity: 2, unitPriceMinor: 150000, priceOverridden: false, priceOverrideReason: null },
    { productId: "p2", productName: "Samrice Jasmine 25kg", sku: "JAS-25", quantity: 1, unitPriceMinor: 135000, priceOverridden: true, priceOverrideReason: "Dented sack (ana)" },
    { productId: "p3", productName: "Samrice Brown 5kg", sku: "BRN-5", quantity: 3, unitPriceMinor: 33000, priceOverridden: false, priceOverrideReason: null },
  ];
  const ask = (items: { sku?: string; name?: string; unitPriceMinor: number }[]) => priceChangeLines(lines, { items, reason: "Suki price", by: "owner" });

  // By code, even when the hub still has an old name.
  assert.deepEqual(ask([{ sku: "dino-25", name: "Old name", unitPriceMinor: 140000 }]), {
    lines: [
      { productId: "p1", quantity: 2, unitPriceMinorOverride: 140000, priceOverrideReason: "Suki price (owner, SE Corp Hub)" },
      { productId: "p2", quantity: 1, unitPriceMinorOverride: 135000, priceOverrideReason: "Dented sack (ana)" },
      // Not changed before: it keeps the price it was sold at, whatever the list price is today.
      { productId: "p3", quantity: 3, unitPriceMinorOverride: 33000, priceOverrideReason: "Price given on the Page (SE Corp Hub)" },
    ],
  });
  // By name when there is no code.
  const byName = ask([{ name: "samrice  brown 5kg", unitPriceMinor: 30000 }]);
  assert.ok("lines" in byName && byName.lines?.[2]?.unitPriceMinorOverride === 30000);
  // Already at these prices (the hub asked again after a lost answer): nothing to do.
  assert.deepEqual(ask([{ sku: "DINO-25", unitPriceMinor: 150000 }]), { lines: null });
  // Not on the order any more.
  assert.deepEqual(ask([{ name: "Samrice Malagkit 25kg", unitPriceMinor: 1 }]), { error: '"Samrice Malagkit 25kg" is not on this order in Sam Store now' });
  // A line whose item was deleted cannot be saved again from here.
  const gone = priceChangeLines([{ ...lines[0]!, productId: null }, lines[1]!], { items: [{ sku: "JAS-25", unitPriceMinor: 130000 }], reason: "r", by: "o" });
  assert.ok("error" in gone && /no longer an item in Sam Store/.test(gone.error));
});
