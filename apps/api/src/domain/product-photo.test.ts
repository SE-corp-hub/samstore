import { test } from "node:test";
import assert from "node:assert/strict";
import { isPhotoKey, newPhotoKey, parsePhoto, PHOTO_MAX_BYTES } from "./product-photo.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const url = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString("base64")}`;

test("a small JPEG or PNG picture is accepted", () => {
  const j = parsePhoto(url("image/jpeg", jpeg));
  assert.ok(j.ok && j.mime === "image/jpeg" && Buffer.from(j.data).equals(jpeg));
  assert.ok(parsePhoto(url("image/png", png)).ok);
});

test("other types, renamed files and empty input are refused", () => {
  assert.equal(parsePhoto(url("image/gif", jpeg)).ok, false);
  assert.equal(parsePhoto(url("image/png", jpeg)).ok, false); // says PNG, is JPEG
  assert.equal(parsePhoto(url("image/jpeg", Buffer.from("<svg onload=x>"))).ok, false);
  assert.equal(parsePhoto("").ok, false);
  assert.equal(parsePhoto(undefined).ok, false);
  assert.equal(parsePhoto("https://example.com/a.jpg").ok, false);
});

test("a picture over the size cap is refused", () => {
  const big = Buffer.concat([jpeg, Buffer.alloc(PHOTO_MAX_BYTES)]);
  assert.equal(parsePhoto(url("image/jpeg", big)).ok, false);
});

test("photo keys are random and checked", () => {
  const a = newPhotoKey();
  assert.notEqual(a, newPhotoKey());
  assert.ok(isPhotoKey(a));
  assert.equal(isPhotoKey("../etc/passwd"), false);
  assert.equal(isPhotoKey("short"), false);
});
