// Module 2 fix — runtime DTO validation at the API boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertDto,
  checkDto,
  CHECKOUT_DTO,
  CART_ADD_DTO,
  LOGIN_DTO,
  REGISTER_DTO,
  type ObjectRule,
} from "./validate.js";

const SHAPE: ObjectRule = {
  kind: "object",
  fields: {
    name: { kind: "string", required: true, min: 2, max: 10 },
    qty: { kind: "int", required: true, min: 1, max: 5 },
    mode: { kind: "string", values: ["a", "b"] },
    note: { kind: "string", max: 20 },
    flag: { kind: "bool" },
  },
};

test("valid input passes and is trimmed", () => {
  const r = checkDto<{ name: string; qty: number }>({ name: "  ok  ", qty: 3 }, SHAPE);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.name, "ok");
});

test("collects ALL errors at once (not just the first)", () => {
  const r = checkDto({ qty: "three" }, SHAPE);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.some((e) => e.includes("name is required")), JSON.stringify(r.errors));
    assert.ok(r.errors.some((e) => e.includes("qty must be an integer")), JSON.stringify(r.errors));
  }
});

test("rejects unknown keys — a typo cannot ride along silently", () => {
  const r = checkDto({ name: "ok", qty: 1, storeId: "some-other-store" }, SHAPE);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("storeId is not an allowed field")), JSON.stringify(r.errors));
});

test("enforces bounds and enums", () => {
  for (const bad of [
    { name: "x", qty: 1 },                 // name too short
    { name: "a".repeat(11), qty: 1 },      // name too long
    { name: "ok", qty: 0 },                // below min
    { name: "ok", qty: 6 },                // above max
    { name: "ok", qty: 1, mode: "c" },     // bad enum
    { name: "ok", qty: 1, flag: "yes" },   // wrong type
  ]) {
    assert.equal(checkDto(bad, SHAPE).ok, false, JSON.stringify(bad));
  }
  assert.equal(checkDto({ name: "ok", qty: 5, mode: "b", flag: true }, SHAPE).ok, true);
});

test("array rule: validates each item, bounds the count and rejects unknown item keys", () => {
  const rule: ObjectRule = {
    kind: "object",
    fields: {
      idempotencyKey: { kind: "string", required: true, min: 8 },
      tenders: {
        kind: "array",
        required: true,
        min: 1,
        max: 2,
        item: {
          kind: "object",
          fields: { methodCode: { kind: "string", required: true }, amountMinor: { kind: "int", required: true, min: 1 } },
        },
      },
    },
  };

  const ok = checkDto<{ tenders: { methodCode: string; amountMinor: number }[] }>(
    { idempotencyKey: "n2-validate-1", tenders: [{ methodCode: "cash", amountMinor: 100 }] },
    rule,
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.ok && ok.value.tenders.length, 1);

  const empty = checkDto({ idempotencyKey: "n2-validate-2", tenders: [] }, rule);
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false && empty.errors.some((e) => e.includes("at least 1")), true);

  const tooMany = checkDto({ idempotencyKey: "n2-validate-3", tenders: [{ methodCode: "cash", amountMinor: 1 }, { methodCode: "cash", amountMinor: 1 }, { methodCode: "cash", amountMinor: 1 }] }, rule);
  assert.equal(tooMany.ok, false);

  const badItem = checkDto({ idempotencyKey: "n2-validate-4", tenders: [{ methodCode: "cash", amountMinor: 0 }] }, rule);
  assert.equal(badItem.ok, false);
  assert.equal(badItem.ok === false && badItem.errors.some((e) => e.startsWith("tenders[0].amountMinor")), true, "errors name the offending item");

  const unknownItemKey = checkDto({ idempotencyKey: "n2-validate-5", tenders: [{ methodCode: "cash", amountMinor: 1, sneaky: true }] }, rule);
  assert.equal(unknownItemKey.ok, false);
  assert.equal(unknownItemKey.ok === false && unknownItemKey.errors.some((e) => e.includes("tenders[0].sneaky")), true);

  const notAnArray = checkDto({ idempotencyKey: "n2-validate-6", tenders: "cash" }, rule);
  assert.equal(notAnArray.ok, false);
});

test("rejects non-object bodies", () => {
  for (const bad of [null, undefined, "string", 42, [1, 2]]) {
    assert.equal(checkDto(bad, SHAPE).ok, false, String(bad));
  }
});

test("assertDto throws a 422 in the ApiError validation shape", () => {
  try {
    assertDto({ name: "ok", qty: 0 }, SHAPE);
    assert.fail("should have thrown");
  } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => { type: string; errors: string[] } };
    assert.equal(err.getStatus?.(), 422);
    const body = err.getResponse?.();
    assert.equal(body?.type, "validation");
    assert.ok(Array.isArray(body?.errors) && body.errors.length > 0);
  }
});

test("CHECKOUT_DTO: accepts a real payload, rejects junk before any DB work", () => {
  const ok = checkDto(
    {
      cartToken: "cart-abcdef123456",
      customerName: "Juan Dela Cruz",
      customerPhone: "+639171234567",
      deliveryType: "delivery",
      paymentMethod: "cod",
      idempotencyKey: "idem-abcdef123456",
      deliveryAddressLine1: "12 Mabini St",
      loyaltyPoints: 100,
    },
    CHECKOUT_DTO,
  );
  assert.equal(ok.ok, true, JSON.stringify(ok));

  const bads: unknown[] = [
    { cartToken: "short", customerName: "Jo", customerPhone: "+639171234567", idempotencyKey: "idem-abcdef123456" }, // cartToken/bame too short
    { cartToken: "cart-abcdef123456", customerName: "Juan", customerPhone: "+639171234567", idempotencyKey: "idem-abcdef123456", deliveryType: "rocket" }, // enum
    { cartToken: "cart-abcdef123456", customerName: "Juan", customerPhone: "+639171234567", idempotencyKey: "idem-abcdef123456", loyaltyPoints: -5 }, // negative points
    { cartToken: "cart-abcdef123456", customerName: "Juan", customerPhone: "+639171234567", idempotencyKey: "idem-abcdef123456", totalMinor: 1 }, // client-supplied total
    { cartToken: "cart-abcdef123456", customerName: "Juan", customerPhone: "+639171234567" }, // missing idempotencyKey
  ];
  for (const bad of bads) {
    assert.equal(checkDto(bad, CHECKOUT_DTO).ok, false, JSON.stringify(bad));
  }
});

test("CART_ADD_DTO / LOGIN_DTO / REGISTER_DTO guard their boundaries", () => {
  assert.equal(checkDto({ productId: "prod-12345678", quantity: 2 }, CART_ADD_DTO).ok, true);
  assert.equal(checkDto({ productId: "prod-12345678", quantity: 0 }, CART_ADD_DTO).ok, false);
  assert.equal(checkDto({ productId: "prod-12345678", quantity: 1000 }, CART_ADD_DTO).ok, false);
  assert.equal(checkDto({ productId: "x", quantity: 1 }, CART_ADD_DTO).ok, false);

  assert.equal(checkDto({ email: "a@b.co", password: "whatever" }, LOGIN_DTO).ok, true);
  assert.equal(checkDto({ identifier: "+639171234567", password: "whatever" }, LOGIN_DTO).ok, true);
  // A1: register accepts phone-only OR email; must not accept role/storeId.
  assert.equal(checkDto({ phone: "09171234567", password: "password1" }, REGISTER_DTO).ok, true);
  assert.equal(checkDto({ email: "a@b.co", password: "password1" }, REGISTER_DTO).ok, true);
  assert.equal(checkDto({ email: "a@b.co", password: "password1", role: "PLATFORM_ADMIN" }, REGISTER_DTO).ok, false);
  assert.equal(checkDto({ email: "a@b.co", password: "password1", storeId: "x" }, REGISTER_DTO).ok, false);
  assert.equal(checkDto({ email: "a@b.co", password: "short" }, REGISTER_DTO).ok, false);
  assert.equal(checkDto({ email: "a@b.co" }, REGISTER_DTO).ok, false);
});
