// A sale saved on the tablet with no internet: the server's numbers cannot be read, so the tablet
// takes what the sale took off its own copy of the shelf (sacks, or grams of kilo rice).

export function takeOffShelf<T extends { id: string; stock: Record<string, number> }>(items: T[], taken: { productId: string; units: number; at: string }[]): T[] {
  const by = new Map<string, { units: number; at: string }[]>();
  // A negative amount puts stock back (a sack opened offline adds kilos to its kilo rice).
  for (const t of taken) if (t.units !== 0 && t.at) by.set(t.productId, [...(by.get(t.productId) ?? []), t]);
  return items.map((it) => {
    const mine = by.get(it.id);
    if (!mine) return it;
    const stock = { ...it.stock };
    for (const t of mine) stock[t.at] = (stock[t.at] ?? 0) - t.units;
    return { ...it, stock };
  });
}

type Shelf = { id: string; priceMinor?: number; loose?: boolean; gramsPerUnit?: number | null };
type Step = { path: string; body: unknown };
type Taken = { productId: string; units: number; at: string };

/**
 * What the steps still waiting on this tablet (sales and sacks opened with no internet) take off each
 * store's shelf. Neither the server's list nor the copy saved on the tablet has them yet, so every
 * price list shown on POS or Pre-order takes them off again: switching store and back, or opening the
 * screen again with no internet, keeps "left" true for the store chosen in "Selling at".
 */
export function waitingShelf(steps: Step[], items: Shelf[]): Taken[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: Taken[] = [];
  for (const s of steps) {
    const b = (s.body ?? {}) as Record<string, unknown>;
    if (s.path === "/admin/benta" && typeof b.locationId === "string" && Array.isArray(b.lines)) {
      for (const raw of b.lines as Record<string, unknown>[]) {
        const productId = String(raw.productId ?? "");
        const at = typeof raw.sourceLocationId === "string" && raw.sourceLocationId ? raw.sourceLocationId : b.locationId;
        const it = byId.get(productId);
        let units = 0;
        if (raw.quantity !== undefined) units = Number(raw.quantity) || 0;
        else if (raw.kilos !== undefined) units = Math.round((Number(raw.kilos) || 0) * 1000);
        else if (raw.amountMinor !== undefined) {
          // "₱ worth" of kilo rice: the grams that money bought at the line's price.
          const price = Number(raw.unitPriceMinorOverride ?? it?.priceMinor ?? 0);
          units = price > 0 ? Math.round(((Number(raw.amountMinor) || 0) / price) * 1000) : 0;
        }
        if (productId && units > 0) out.push({ productId, units, at });
      }
    } else if (s.path === "/admin/resacks/open-for-kilos" && typeof b.locationId === "string") {
      const sack = byId.get(String(b.sackProductId ?? ""));
      const n = Number(b.sacks) || 0;
      if (!sack || n <= 0) continue;
      out.push({ productId: sack.id, units: n, at: b.locationId });
      if (sack.gramsPerUnit) out.push({ productId: String(b.kiloProductId ?? ""), units: -n * sack.gramsPerUnit, at: b.locationId });
    }
  }
  return out;
}
