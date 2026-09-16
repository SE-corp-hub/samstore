import { test } from "node:test";
import assert from "node:assert/strict";
import { toE164, isPhMobile, formatPh } from "./phone.js";

test("A1: the 5 accepted spellings of one number normalize to +63…", () => {
  const expected = "+639171234567";
  assert.equal(toE164("09171234567"), expected);
  assert.equal(toE164("9171234567"), expected);
  assert.equal(toE164("639171234567"), expected);
  assert.equal(toE164("+639171234567"), expected);
  assert.equal(toE164("0917 123-4567"), expected);
});

test("A1: spaced and dashed shorter forms still normalize", () => {
  assert.equal(toE164("639 171 234 567"), "+639171234567");
  assert.equal(toE164("+63 917 123 4567"), "+639171234567");
});

test("A1: landline and garbage are rejected", () => {
  assert.equal(isPhMobile("02 8123 4567"), false);
  assert.equal(isPhMobile("+63 2 8123 4567"), false);
  assert.equal(isPhMobile("123"), false);
  assert.equal(isPhMobile("abc123"), false);
  assert.equal(isPhMobile(null), false);
  assert.equal(isPhMobile(undefined), false);
  assert.equal(toE164("02 8123 4567"), "");
});

test("A1: formatPh renders a friendly 0xxx-xxx-xxxx display", () => {
  assert.equal(formatPh("09171234567"), "0917 123 4567");
  assert.equal(formatPh("invalid"), "invalid");
  assert.equal(formatPh(null), "");
});