// P6b: Messenger journey state machine — PURE (live-data-only).
// Every reply is built from the provided context (categories/products/order lookup);
// the engine NEVER invents stock, price, or order status. Sends are emitted as
// templates and routed through the suppressed/mock adapter by the service.

import { text, button, carousel, MENU_REPLIES, truncate, type ReplyTemplate, type QuickReply } from "./templates.js";

export interface JourneyCategory {
  id: string;
  name: string;
}

export interface JourneyProduct {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  availableQuantity: number | null;
  categoryName: string | null;
  images: string[];
}

export interface JourneyOrderLookup {
  orderNumber: string;
  status: string;
  totalMinor: number;
  customerName: string;
}

export interface JourneyContext {
  storeName: string;
  categories: JourneyCategory[];
  products: JourneyProduct[];
  /** Live order lookup by claim token — null when unknown/invalid. */
  lookupOrder?: (claimToken: string) => Promise<JourneyOrderLookup | null>;
}

export interface JourneyState {
  node: string;
  args: Record<string, string>;
}

export interface JourneyTurn {
  state: JourneyState;
  replies: ReplyTemplate[];
}

export const ROOT: JourneyState = { node: "root", args: {} };

function peso(minor: number): string {
  return `₱${(minor / 100).toFixed(2)}`;
}

export function startJourney(): JourneyState {
  return ROOT;
}

/** The one entry point: given a state + incoming message, produce replies + next state. */
export async function journeyTurn(state: JourneyState, input: { text?: string; payload?: string }, ctx: JourneyContext): Promise<JourneyTurn> {
  const payload = (input.payload ?? "").trim();
  const textIn = (input.text ?? "").trim();

  // Explicit payload routing first.
  if (payload === "menu" || payload === "categories") return categoriesTurn(ctx);
  if (payload === "track") return { state: { node: "track", args: {} }, replies: [text("Paste your order tracking token and I'll check it for you.", [{ title: "Back", payload: "menu" }])] };
  if (payload === "info") return { state: { node: "root", args: {} }, replies: [text(`Hi! This is ${ctx.storeName}'s Messenger. Browse the menu, or track an order anytime.`, MENU_REPLIES)] };
  if (payload.startsWith("category:")) {
    const id = payload.slice("category:".length);
    return categoryTurn(id, ctx);
  }
  if (payload.startsWith("product:")) {
    const id = payload.slice("product:".length);
    return productTurn(id, ctx);
  }
  if (payload.startsWith("track:")) {
    const token = payload.slice("track:".length);
    return { state: { node: "root", args: {} }, replies: [await resolveTracking(token, ctx)] };
  }

  // Natural text: order-tracking token, then category/product search.
  if (textIn.length > 0) {
    if (/^[\w-]{12,}$/.test(textIn)) {
      return { state: { node: "root", args: {} }, replies: [await resolveTracking(textIn, ctx)] };
    }
    const cat = ctx.categories.find((c) => c.name.toLowerCase() === textIn.toLowerCase());
    if (cat) return categoryTurn(cat.id, ctx);
    const hits = ctx.products.filter((p) => p.name.toLowerCase().includes(textIn.toLowerCase()));
    if (hits.length === 1) return productTurn(hits[0]!.id, ctx);
    if (hits.length > 1) {
      return {
        state: { node: "search", args: { q: textIn } },
        replies: [carousel(hits.slice(0, 8).map((p) => productElement(p)))],
      };
    }
  }

  // Fall back to the welcome/menu.
  return categoriesTurn(ctx);
}

function categoriesTurn(ctx: JourneyContext): JourneyTurn {
  const replies: QuickReply[] = ctx.categories.slice(0, 8).map((c) => ({ title: truncate(c.name, 20), payload: `category:${c.id}` }));
  replies.push({ title: "Track order", payload: "track" });
  replies.push({ title: "Store info", payload: "info" });
  const lines = ctx.categories.length
    ? `Here's what we have today:` + ctx.categories.map((c) => `\n• ${c.name}`).join("")
    : `We don't have anything listed right now.`;
  return { state: { node: "root", args: {} }, replies: [text(lines, replies)] };
}

function categoryTurn(id: string, ctx: JourneyContext): JourneyTurn {
  const products = ctx.products.filter((p) => p.categoryName === ctx.categories.find((c) => c.id === id)?.name || ctx.products.some((p) => p.id === id));
  const inCat = ctx.products.filter((p) => {
    const cat = ctx.categories.find((c) => c.id === id);
    return cat && p.categoryName === cat.name;
  });
  const list = inCat.length ? inCat : products;
  if (list.length === 0) {
    return { state: { node: "root", args: {} }, replies: [text("That category is empty right now.", MENU_REPLIES)] };
  }
  const elements = list.slice(0, 8).map((p) => productElement(p));
  return {
    state: { node: `category:${id}`, args: {} },
    replies: [carousel(elements), text("Pick one, or", [{ title: "Back to menu", payload: "menu" }, { title: "Track order", payload: "track" }])],
  };
}

function productElement(p: JourneyProduct) {
  return {
    title: truncate(p.name, 24),
    subtitle: truncate(`${p.description ?? ""} — ${peso(p.priceMinor)}${p.availableQuantity != null ? ` · ${p.availableQuantity} in stock` : ""}`, 64),
    imageUrl: p.images[0] ?? null,
    buttons: [{ title: "Details", payload: `product:${p.id}` }],
  };
}

function productTurn(id: string, ctx: JourneyContext): JourneyTurn {
  const p = ctx.products.find((x) => x.id === id);
  if (!p) return { state: { node: "root", args: {} }, replies: [text("I couldn't find that item.", MENU_REPLIES)] };
  const stock = p.availableQuantity == null ? "available" : p.availableQuantity > 0 ? `${p.availableQuantity} in stock` : "currently out of stock";
  const replies: QuickReply[] = [
    { title: "Order via web", payload: "info" },
    { title: "Track order", payload: "track" },
    { title: "Back to menu", payload: "menu" },
  ];
  const t = text(`${p.name} — ${peso(p.priceMinor)}\n${stock}${p.description ? `\n${p.description}` : ""}`, replies);
  return { state: { node: `product:${id}`, args: {} }, replies: [t] };
}

/** Resolve the tracking reply against live order data. */
export async function resolveTracking(token: string, ctx: JourneyContext): Promise<ReplyTemplate> {
  const order = ctx.lookupOrder ? await ctx.lookupOrder(token) : null;
  if (!order) return text("I couldn't find an order with that token. Double-check it and try again.", MENU_REPLIES);
  return button(`Order ${order.orderNumber} is ${order.status.replace(/_/g, " ").toLowerCase()}. Total ${peso(order.totalMinor)} for ${order.customerName ?? "you"}.`, [{ title: "Track again", payload: "track" }]);
}