// Finding one product among many (50+ SKUs) at the counter: forgiving search, variety groups,
// and the products this phone sells most.

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

/**
 * Every typed word must start a word of the name ("din 25" → Dinorado 25 kg), or the typed
 * text is the name's first letters ("ds" → Dinorado Special) or simply inside the name.
 */
export function matchesSearch(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const n = name.toLowerCase();
  if (n.includes(q)) return true;
  const nameWords = words(n);
  if (nameWords.map((w) => w[0]).join("").startsWith(q.replace(/\s+/g, ""))) return true;
  return words(q).every((t) => nameWords.some((w) => w.startsWith(t)));
}

/** The variety a product belongs to: its name without the size ("Brown Rice 25 kg" and
    "Brown Rice (tingi)" → "Brown Rice"). */
export function groupOf(name: string): string {
  const v = name.replace(/\(.*?\)/g, " ").replace(/\b\d+(\.\d+)?\s*(kg|kilos?|g|grams?|l|ml|pcs?|sacks?)\b/gi, " ").replace(/\s+/g, " ").trim();
  return v ? v.replace(/\b\w/g, (c) => c.toUpperCase()) : "Other";
}

/** Varieties with only one product go together under "Other", so the filter buttons stay few. */
export function groupsFor(names: string[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const n of names) count.set(groupOf(n), (count.get(groupOf(n)) ?? 0) + 1);
  return new Map(names.map((n) => [n, (count.get(groupOf(n)) ?? 0) > 1 ? groupOf(n) : "Other"]));
}

/** How often each product was tapped on this device, so the usual ones come first. */
const useKey = (list: string) => `product-use:${list}`;
export function noteUse(list: string, productId: string) {
  try {
    const m = JSON.parse(window.localStorage.getItem(useKey(list)) ?? "{}") as Record<string, number>;
    m[productId] = (m[productId] ?? 0) + 1;
    window.localStorage.setItem(useKey(list), JSON.stringify(m));
  } catch { /* convenience only */ }
}
export function mostUsed(list: string, max: number): string[] {
  try {
    const m = JSON.parse(window.localStorage.getItem(useKey(list)) ?? "{}") as Record<string, number>;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, max).map(([id]) => id);
  } catch { return []; }
}
