// Rice Ops M10 — the contrast and size check for the store screens (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, RICE_SIZES, RICE_TOKENS as T } from "./riceTheme.js";

test("M10: black ink on white is 7:1 or better (AAA) — readable in daylight", () => {
  assert.ok(contrast(T.ink, T.paper) >= 7, `${contrast(T.ink, T.paper)}`);
});

test("M10: white text on every action button passes AA large and normal text (≥ 4.5:1)", () => {
  assert.ok(contrast("#FFFFFF", T.action) >= 4.5, `${contrast("#FFFFFF", T.action)}`);
  assert.ok(contrast("#FFFFFF", T.actionHover) >= 4.5);
});

test("M10: each status word is readable on its own badge colour (≥ 4.5:1)", () => {
  for (const [fg, bg] of [[T.waiting, T.waitingBg], [T.onTheWay, T.onTheWayBg], [T.short, T.shortBg], [T.right, T.rightBg]] as const) {
    assert.ok(contrast(fg, bg) >= 4.5, `${fg} on ${bg}: ${contrast(fg, bg)}`);
  }
});

test("M10: sizes for older eyes and thumbs", () => {
  assert.ok(RICE_SIZES.bodyPx >= 18);
  assert.ok(RICE_SIZES.numberPx >= 22 && RICE_SIZES.totalPx >= 28);
  assert.ok(RICE_SIZES.minTapPx >= 48, "Android's minimum comfortable tap target");
});
