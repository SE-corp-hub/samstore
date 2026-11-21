// A sale saved on the tablet with no internet: the server's numbers cannot be read, so the tablet
// takes what the sale took off its own copy of the shelf (sacks, or grams of kilo rice).

export function takeOffShelf<T extends { id: string; stock: Record<string, number> }>(items: T[], taken: { productId: string; units: number; at: string }[]): T[] {
  const by = new Map<string, { units: number; at: string }[]>();
  for (const t of taken) if (t.units > 0 && t.at) by.set(t.productId, [...(by.get(t.productId) ?? []), t]);
  return items.map((it) => {
    const mine = by.get(it.id);
    if (!mine) return it;
    const stock = { ...it.stock };
    for (const t of mine) stock[t.at] = (stock[t.at] ?? 0) - t.units;
    return { ...it, stock };
  });
}
