// 2026-11-21: where a customer or an item was made (the API's domain/added-where.ts), in plain words for the lists,
// and the "Made at" filter on Customers and Products.

export interface AddedTag {
  addedAt?: { id: string; name: string } | null;
  addedVia?: string | null;
  addedBy?: string | null;
}

/** The screen, as the owner calls it. */
export const VIA_WORDS: Record<string, string> = {
  POS: "POS", PREORDER: "Pre-order", STOCK_IN: "Stock in", CREDIT: "Credit", CUSTOMERS: "Customers",
  PRODUCTS: "Products", AGENT: "Agent order", IMPORT: "From Excel", ONLINE: "Online shop", KILO: "Per kilo",
  COUNTER: "POS or Pre-order",
};

/** "Lipa · POS · Juan", "Products · Owner", or "Unknown" for a row made before this was kept. */
export function addedWords(t: AddedTag): string {
  if (!t.addedVia && !t.addedAt) return "Unknown";
  return [t.addedAt?.name, t.addedVia ? VIA_WORDS[t.addedVia] ?? t.addedVia : null, t.addedBy].filter(Boolean).join(" · ");
}

/** The "Made at" filter: "" = everyone, a store id, "none" = not at a store (owner, Excel, online), "unknown" = made before. */
export function matchesAddedAt(t: AddedTag, filter: string): boolean {
  if (!filter) return true;
  if (filter === "unknown") return !t.addedVia && !t.addedAt;
  if (filter === "none") return !t.addedAt && !!t.addedVia;
  return t.addedAt?.id === filter;
}

/** The stores that appear in a list, for the filter (sorted by name). */
export function addedStores(rows: AddedTag[]): { id: string; name: string }[] {
  const m = new Map<string, string>();
  for (const r of rows) if (r.addedAt) m.set(r.addedAt.id, r.addedAt.name);
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
