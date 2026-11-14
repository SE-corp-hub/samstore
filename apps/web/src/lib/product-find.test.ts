import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSearch, groupOf, groupsFor, sizeOf, sizesFor } from "./product-find";

test("a typed word matches the start of any word in the name", () => {
  assert.ok(matchesSearch("Dinorado 25 kg", "din 25"));
  assert.ok(matchesSearch("Dinorado 25 kg", "25"));
  assert.ok(matchesSearch("Sinandomeng (tingi)", "tingi"));
  assert.ok(!matchesSearch("Dinorado 25 kg", "sin"));
});

test("first letters and plain text inside the name both match", () => {
  assert.ok(matchesSearch("Jasmine Premium 5 kg", "jp"));
  assert.ok(matchesSearch("Dinorado 25 kg", "rado"));
  assert.ok(matchesSearch("Anything", "  "));
});

test("the variety is the name without its size", () => {
  assert.equal(groupOf("sinandomeng 25 kg"), "Sinandomeng");
  assert.equal(groupOf("Brown Rice (tingi)"), "Brown Rice");
  assert.equal(groupOf("Premium Brown 5kg"), "Premium Brown");
  assert.equal(groupOf(""), "Other");
});

test("a variety with one product goes under Other", () => {
  const g = groupsFor(["Jasmine 5 kg", "Jasmine 25 kg", "Cooking oil 1 L"]);
  assert.equal(g.get("Jasmine 25 kg"), "Jasmine");
  assert.equal(g.get("Cooking oil 1 L"), "Other");
});

test("a name with a common kind of rice goes under that kind", () => {
  assert.equal(groupOf("Riz Dinorado 25kg"), "Dinorado");
  assert.equal(groupOf("White Aroma dinorado 25kg"), "Dinorado");
  assert.equal(groupOf("Sam Jasmine 5kg"), "Jasmine");
  assert.equal(groupOf("Aroma 5kg"), "Aroma");
  assert.equal(groupOf("Perfect Blue 25kg"), "Blue");
  assert.equal(groupOf("Mango 5kg"), "Mango");
  const g = groupsFor(["Mango 25kg", "Mango 5kg", "Alsa 25kg", "Crystal Dinorado 5kg", "Riz Dinorado 25kg"]);
  assert.equal(g.get("Mango 5kg"), "Mango");
  assert.equal(g.get("Riz Dinorado 25kg"), "Dinorado");
  assert.equal(g.get("Alsa 25kg"), "Other");
});

test("the pack size is read from the name, and two or more sizes get buttons", () => {
  assert.equal(sizeOf("Riz Dinorado 25kg"), "25kg");
  assert.equal(sizeOf("Sinandomeng 5 kg"), "5kg");
  assert.equal(sizeOf("Sinandomeng (tingi)"), null);
  assert.deepEqual(sizesFor(["Mango 5kg", "Mango 25kg", "Alsa 25 kg", "Sinandomeng (tingi)"]), ["25kg", "5kg"]);
  assert.deepEqual(sizesFor(["Alsa 25kg", "Riz 25kg"]), [], "one size only: no buttons");
});

test("the store's own groups win when most products have one", async () => {
  const { finderGroups, sortGroups } = await import("./product-find");
  const g = finderGroups([
    { name: "Alsa 25kg", group: "Imported" }, { name: "Mango 5kg", group: "5kg" },
    { name: "Riz Dinorado 25kg", group: "Premium" }, { name: "Odd rice", group: null },
  ]);
  assert.equal(g.get("Alsa 25kg"), "Imported");
  assert.equal(g.get("Odd rice"), "Other");
  assert.deepEqual(sortGroups(g.values()), ["Imported", "Premium", "5kg", "Other"]);
  // Few products with a group: the kinds from the names, as before.
  const k = finderGroups([{ name: "Crystal Dinorado 25kg" }, { name: "Riz Dinorado 25kg", group: "Premium" }, { name: "Mango 25kg" }, { name: "Alsa 25kg" }, { name: "Planters 25kg" }]);
  assert.equal(k.get("Crystal Dinorado 25kg"), "Dinorado");
});
