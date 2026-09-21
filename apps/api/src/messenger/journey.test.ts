// P6b: journey state machine — pure, live-data-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { journeyTurn, startJourney, type JourneyContext } from "./journey.js";

const ctx: JourneyContext = {
  storeName: "Kape PH",
  categories: [
    { id: "c1", name: "Drinks" },
    { id: "c2", name: "Pastries" },
  ],
  products: [
    { id: "p1", name: "Kape Barako", description: "Strong brewed coffee", priceMinor: 12000, availableQuantity: 10, categoryName: "Drinks", images: [] },
    { id: "p2", name: "Turon", description: "Banana lumpia", priceMinor: 6000, availableQuantity: 0, categoryName: "Pastries", images: [] },
  ],
  lookupOrder: async (token) =>
    token === "good-token-1234"
      ? { orderNumber: "PIN-2026-000001", status: "OUT_FOR_DELIVERY", totalMinor: 18000, customerName: "Maria" }
      : null,
};

test("welcome (no input) shows the category menu", async () => {
  const turn = await journeyTurn(startJourney(), { text: "" }, ctx);
  const t = turn.replies.find((r) => r.type === "text") as { text: string; quickReplies?: { title: string; payload: string }[] };
  assert.ok(t.text.includes("Drinks"));
  assert.ok(t.text.includes("Pastries"));
  assert.ok(t.quickReplies?.some((q) => q.payload === "category:c1"));
});

test("menu payload lists categories with quick replies", async () => {
  const turn = await journeyTurn(startJourney(), { payload: "menu" }, ctx);
  const t = turn.replies[0] as { text: string; quickReplies?: { title: string; payload: string }[] };
  assert.ok(t.quickReplies?.some((q) => q.payload === "track"), "track quick reply present");
});

test("category payload returns a product carousel built from LIVE data", async () => {
  const turn = await journeyTurn(startJourney(), { payload: "category:c1" }, ctx);
  const carousel = turn.replies.find((r) => r.type === "carousel");
  assert.ok(carousel, "carousel returned");
  if (carousel?.type !== "carousel") return;
  assert.equal(carousel.elements.length, 1);
  assert.ok(carousel.elements[0]?.subtitle.includes("₱120.00"));
  assert.ok(carousel.elements[0]?.subtitle.includes("10 in stock"), "live stock, never invented");
});

test("product payload returns live price + stock", async () => {
  const turn = await journeyTurn(startJourney(), { payload: "product:p2" }, ctx);
  const t = turn.replies[0] as { text: string };
  assert.ok(t.text.includes("₱60.00"));
  assert.ok(t.text.includes("out of stock"), "live availability");
});

test("track payload prompts for a token", async () => {
  const turn = await journeyTurn(startJourney(), { payload: "track" }, ctx);
  const t = turn.replies[0] as { text: string };
  assert.ok(t.text.toLowerCase().includes("token"));
});

test("a valid token returns the LIVE order status", async () => {
  const turn = await journeyTurn(startJourney(), { payload: "track:good-token-1234" }, ctx);
  const t = turn.replies.find((r) => r.type === "button") as { text: string };
  assert.ok(t, "order status arrives as a button template");
  assert.ok(t.text.includes("PIN-2026-000001"));
  assert.ok(t.text.includes("out for delivery"));
  assert.ok(t.text.includes("₱180.00"));
});

test("an unknown token is never invented", async () => {
  const turn = await journeyTurn(startJourney(), { text: "no-such-token-zzz" }, ctx);
  const t = turn.replies.find((r) => r.type === "text") as { text: string };
  assert.match(t.text, /couldn't find/i);
});

test("natural-text category name routes to that category", async () => {
  const turn = await journeyTurn(startJourney(), { text: "Pastries" }, ctx);
  const carousel = turn.replies.find((r) => r.type === "carousel");
  assert.ok(carousel, "routed by name");
  if (carousel?.type === "carousel") assert.equal(carousel.elements[0]?.title, "Turon");
});

test("search text matching one product shows its detail", async () => {
  const turn = await journeyTurn(startJourney(), { text: "turon" }, ctx);
  const t = turn.replies.find((r) => r.type === "text") as { text: string };
  assert.ok(t.text.includes("Turon"));
});