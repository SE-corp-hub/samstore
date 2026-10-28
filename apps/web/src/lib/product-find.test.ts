import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSearch, groupOf, groupsFor } from "./product-find";

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
  assert.equal(groupOf("Premium Dinorado 5kg"), "Premium Dinorado");
  assert.equal(groupOf(""), "Other");
});

test("a variety with one product goes under Other", () => {
  const g = groupsFor(["Jasmine 5 kg", "Jasmine 25 kg", "Cooking oil 1 L"]);
  assert.equal(g.get("Jasmine 25 kg"), "Jasmine");
  assert.equal(g.get("Cooking oil 1 L"), "Other");
});
