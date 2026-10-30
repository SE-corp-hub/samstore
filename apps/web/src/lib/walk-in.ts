// Walk-in sale arithmetic, shared by the screen and its tests.

export interface WalkInItem { id: string; loose: boolean; priceMinor: number; stock: Record<string, number> }

/** Peso amount of a line: pieces × price, or grams × price per kilo with the server's rounding (half a centavo up). */
export function lineTotal(item: Pick<WalkInItem, "loose" | "priceMinor">, qty: number): number {
  if (!item.loose) return qty * item.priceMinor;
  const scaled = qty * item.priceMinor;
  return Math.floor(scaled / 1000) + (scaled % 1000 >= 500 ? 1 : 0);
}

/** The buttons on top: the ones tapped most on this tablet, then the fullest shelves at this store. */
export function bestSellers<T extends WalkInItem>(items: T[], used: string[], locationId: string, max: number): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: T[] = [];
  for (const id of used) { const i = byId.get(id); if (i && !out.includes(i)) out.push(i); }
  const rest = items.filter((i) => !out.includes(i)).sort((a, b) => (b.stock[locationId] ?? 0) - (a.stock[locationId] ?? 0));
  return [...out, ...rest].slice(0, max);
}
