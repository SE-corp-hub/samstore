import { test } from "node:test";
import assert from "node:assert/strict";
import { alphabetical, areaCounts, byArea, customerArea, nameWithTown, storeArea } from "./customer-area";

test("the area comes from the name, then the address, then the store", () => {
  assert.equal(customerArea({ name: "Acel-bauan" }), "bauan");
  assert.equal(customerArea({ name: "Carmen/Michelle-BAUAN" }), "bauan");
  assert.equal(customerArea({ name: "Lipa/Samrice-bauan" }), "bauan"); // the last town word wins
  assert.equal(customerArea({ name: "Aling Rosa - Lipa" }), "lipa");
  assert.equal(customerArea({ name: "Rosa", address: "Brgy. 4, Lipa City" }), "lipa");
  assert.equal(customerArea({ name: "Rosa", address: null, addedAt: { name: "Lipa" } }), "lipa");
  assert.equal(customerArea({ name: "Rosa-bauan", addedAt: { name: "Lipa" } }), "bauan"); // name beats store
  assert.equal(customerArea({ name: "Sample", addedAt: { name: "Bogs and Lucy" } }), "bauan"); // 2026-11-22: not Lipa = Bauan
  assert.equal(customerArea({ name: "Sample" }), null);
  assert.equal(customerArea({ name: null }), null);
});

test("filter by area keeps the chosen customer", () => {
  const list = [{ id: "a", name: "Acel-bauan" }, { id: "b", name: "Rosa", addedAt: { name: "Lipa" } }, { id: "c", name: "Sample" }];
  assert.deepEqual(byArea(list, "").map((c) => c.id), ["a", "b", "c"]);
  assert.deepEqual(byArea(list, "bauan").map((c) => c.id), ["a"]);
  assert.deepEqual(byArea(list, "lipa").map((c) => c.id), ["b"]);
  assert.deepEqual(byArea(list, "lipa", "c").map((c) => c.id), ["b", "c"]);
  assert.deepEqual(areaCounts(list), { lipa: 1, bauan: 1 });
});

test("A to Z, and the town after the name when the name does not say it", () => {
  const list = [{ id: "1", name: "rosa" }, { id: "2", name: "Acel-bauan" }, { id: "3", name: "  ben" }, { id: "4", name: "Carmen" }];
  assert.deepEqual(alphabetical(list).map((c) => c.id), ["2", "3", "4", "1"]);
  assert.deepEqual(byArea(list, "").map((c) => c.id), ["2", "3", "4", "1"]);
  assert.equal(nameWithTown({ name: "Acel-bauan" }), "Acel-bauan");
  assert.equal(nameWithTown({ name: "Aling Rosa", address: "Lipa" }), "Aling Rosa · Lipa");
  assert.equal(nameWithTown({ name: "Ben", addedAt: { name: "Lipa" } }), "Ben · Lipa");
  assert.equal(nameWithTown({ name: "Sample" }), "Sample");
  assert.equal(nameWithTown({ name: null }), "—");
});

test("each store's town: Lipa store = Lipa, every other place = Bauan (2026-11-22)", () => {
  assert.equal(storeArea("Lipa"), "lipa");
  assert.equal(storeArea("Samrice Lipa"), "lipa");
  assert.equal(storeArea("Bogs and Lucy"), "bauan");
  assert.equal(storeArea("Bahay Tindahan"), "bauan");
  assert.equal(storeArea("Bodega"), "bauan");
  assert.equal(storeArea(""), null);
  assert.equal(storeArea(undefined), null);
});
