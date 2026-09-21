// P7: chatbot engine — PURE, LIVE-DATA-ONLY, Taglish-aware.
// Intents are detected by keyword sets; every answer is built ONLY from the provided
// context (categories/products/order lookup/store info). Below the confidence
// threshold → `fallback` (the service hands off to an agent: "I'll ask our staff").
// Never invents stock, price, status, or payment data.

export type ChatIntent =
  | "greeting"
  | "menu"
  | "product_search"
  | "order_status"
  | "store_hours"
  | "store_info"
  | "loyalty"
  | "voucher"
  | "order_token"
  | "fallback";

export interface ChatContext {
  storeName: string;
  storeHours?: string | null;
  categories: string[];
  products: { id: string; name: string; priceMinor: number; availableQuantity: number | null; description: string | null; categoryName: string | null }[];
  loyaltyInfo?: string | null;
  lookupOrder?: (token: string) => Promise<{ orderNumber: string; status: string; totalMinor: number } | null>;
}

export interface ClassifiedIntent {
  intent: ChatIntent;
  confidence: number; // 0..1
  token?: string; // order claim token when order_token
}

export const CONFIDENCE_THRESHOLD = 0.35;

function peso(minor: number): string {
  return `₱${(minor / 100).toFixed(2)}`;
}

/** Taglish keyword sets per intent (kept deliberately small + honest). */
const KEYWORDS: Record<Exclude<ChatIntent, "order_token" | "fallback" | "product_search">, string[]> = {
  greeting: ["hello", "hi po", "hi ", "magandang", "kumusta", "good morning", "good day", "kumusta ka", "uy", "ey"],
  menu: ["menu", "browse", "ano meron", "what do you have", "pagkain", "kain", "product", "item", "pang bili", "listahan"],
  order_status: ["order", "track", "status", "saan na", "nasaan", "delivery", "claim", "sinad", "kuan"],
  store_hours: ["oras", "open", "close", "bukas", "sara", "hours", "what time", "schedule", "what time open", "oras kayo"],
  store_info: ["address", "saan kayo", "saan location", "where", "location", "contact", "phone"],
  loyalty: ["points", "loyalty", "pts", "redeem", "reward", "balance", "puntos"],
  voucher: ["voucher", "coupon", "discount", "promo", "pinas", "code", "sale"],
};

const TOKEN_RE = /[A-Za-z0-9]{12,}/;

export function classify(text: string): ClassifiedIntent {
  const t = ` ${text.toLowerCase().trim()} `;
  const token = TOKEN_RE.exec(t.trim())?.[0];
  if (token && (t.includes("order") || t.includes("track") || t.includes("saan na") || t.includes("status"))) {
    return { intent: "order_token", confidence: 0.95, token };
  }
  // Keyword intents take priority (greeting/menu/order/hours/info/loyalty/voucher).
  let best: Exclude<ChatIntent, "order_token" | "fallback" | "product_search"> = "greeting";
  let bestHits = 0;
  for (const [intent, words] of Object.entries(KEYWORDS)) {
    const hits = words.filter((w) => t.includes(w)).length;
    if (hits > bestHits) {
      best = intent as typeof best;
      bestHits = hits;
    }
  }
  if (bestHits > 0) {
    const confidence = Math.min(0.95, 0.4 + bestHits * 0.25);
    return { intent: best, confidence };
  }
  // Otherwise a plausible product query (min 2 chars, not a pure stopword).
  const q = text.trim();
  if (q.length >= 2 && !/^(hi|hi po|hey|uy|ok|salamat)\b/i.test(q)) {
    return { intent: "product_search", confidence: 0.6 };
  }
  return { intent: "fallback", confidence: 0 };
}

export function isFallback(intent: ClassifiedIntent): boolean {
  return intent.intent === "fallback" || intent.confidence < CONFIDENCE_THRESHOLD;
}

/** Build the answer for an intent from LIVE context. Returns null → hand off to an agent. */
export async function answer(intent: ClassifiedIntent, ctx: ChatContext): Promise<{ reply: string } | null> {
  switch (intent.intent) {
    case "greeting":
      return { reply: `Hi! I'm ${ctx.storeName}'s assistant. Browse our menu, ask about an item, or track an order — ask me "menu", "kape" (or any product), or paste your order token.` };
    case "menu": {
      const list = ctx.categories.length ? ctx.categories.map((c) => `• ${c}`).join("\n") : "We don't have anything listed right now.";
      return { reply: `Here's what we have:\n${list}\n\nAsk for a specific item (e.g. "kape", "turon") for details.` };
    }
    case "product_search": {
      const q = intent.intent === "product_search" ? "" : "";
      void q;
      // The service resolves matched products (it owns live data); here we return
      // null so the caller uses ctx.products directly (see answerProducts).
      return null;
    }
    case "order_status":
      return { reply: `Paste your order token (the code from your order confirmation) and I'll look it up — live only.` };
    case "order_token": {
      if (!intent.token || !ctx.lookupOrder) return { reply: "Order lookup is unavailable right now — please use the web link." };
      const order = await ctx.lookupOrder(intent.token);
      if (!order) return { reply: "I couldn't find an order with that token. Double-check it and try again." };
      return { reply: `Order ${order.orderNumber} is ${order.status.replace(/_/g, " ").toLowerCase()}. Total ${peso(order.totalMinor)}.` };
    }
    case "store_hours":
      return { reply: ctx.storeHours?.trim() ? `We're open: ${ctx.storeHours.trim()}` : "We haven't posted our hours yet — message us and we'll confirm." };
    case "store_info":
      return { reply: `${ctx.storeName} — ${ctx.storeHours?.trim() ?? "hours not posted"}.` };
    case "loyalty":
      return { reply: ctx.loyaltyInfo?.trim() ? ctx.loyaltyInfo.trim() : "We have a loyalty program — ask us for the details!" };
    case "voucher":
      return { reply: `Use your voucher code at checkout on the web store — codes are entered there.` };
    case "fallback":
    default:
      return null; // hand off: "I'll ask our staff"
  }
}

/** Resolve a product search from LIVE products (name contains the query).
 *  Returns null (→ hand off to an agent) when nothing matches — never invents items. */
export function answerProducts(query: string, ctx: ChatContext): string | null {
  const q = query.trim().toLowerCase();
  const hits = ctx.products.filter((p) => p.name.toLowerCase().includes(q) || p.categoryName?.toLowerCase().includes(q));
  if (hits.length === 0) return null;
  if (hits.length === 1) {
    const p = hits[0]!;
    const stock = p.availableQuantity == null ? "available" : p.availableQuantity > 0 ? `${p.availableQuantity} in stock` : "currently out of stock";
    return `${p.name} — ${peso(p.priceMinor)}\n${stock}${p.description ? `\n${p.description}` : ""}`;
  }
  return `I found a few: ${hits.slice(0, 5).map((p) => p.name).join(", ")} — tell me which one.`;
}

export const FALLBACK_REPLY = "I'll ask our staff to help you with that — someone will reply here shortly.";