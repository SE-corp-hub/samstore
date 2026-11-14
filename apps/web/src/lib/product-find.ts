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

/** Kinds of rice that many brands share. A product whose name has one of these words goes under
    that kind, so "Riz Dinorado 25kg", "Crystal Dinorado 5kg" and "White Aroma dinorado" are all
    under Dinorado. The first word found in this order wins ("White Aroma dinorado" → Dinorado). */
const KINDS = ["Dinorado", "Jasmine", "Sinandomeng", "Malagkit", "Japonica", "Aroma", "Blue"];

/** The group a product belongs to: its kind of rice when the name has one (see KINDS), otherwise its
    name without the size ("Brown Rice 25 kg" and "Brown Rice (tingi)" → "Brown Rice"). */
export function groupOf(name: string): string {
  const kind = KINDS.find((k) => new RegExp(`\\b${k}\\b`, "i").test(name));
  if (kind) return kind;
  const v = name.replace(/\(.*?\)/g, " ").replace(/\b\d+(\.\d+)?\s*(kg|kilos?|g|grams?|l|ml|pcs?|sacks?)\b/gi, " ").replace(/\s+/g, " ").trim();
  return v ? v.replace(/\b\w/g, (c) => c.toUpperCase()) : "Other";
}

/** The pack size in a product's name, written the same way every time ("25kg", "5 kg" → "25kg"),
    or null when the name has none (loose rice, "(tingi)", other goods). */
export function sizeOf(name: string): string | null {
  const m = /\b(\d+(?:\.\d+)?)\s*kg\b/i.exec(name);
  return m ? `${Number(m[1])}kg` : null;
}

/** The sizes worth a button: at least two different ones, biggest first, at most four. */
export function sizesFor(names: string[]): string[] {
  const set = [...new Set(names.map(sizeOf).filter((x): x is string => !!x))];
  set.sort((a, b) => parseFloat(b) - parseFloat(a));
  return set.length > 1 ? set.slice(0, 4) : [];
}

/** Varieties with only one product go together under "Other", so the filter buttons stay few. */
export function groupsFor(names: string[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const n of names) count.set(groupOf(n), (count.get(groupOf(n)) ?? 0) + 1);
  return new Map(names.map((n) => [n, (count.get(groupOf(n)) ?? 0) > 1 ? groupOf(n) : "Other"]));
}

/**
 * The groups the finder shows. The store's own groups (Products → Group: the owner's price-list
 * sections, such as Premium, Imported, Local, 5kg) win when at least half of the products have one;
 * a product without one goes under "Other". Otherwise the kind of rice from the name (groupsFor).
 * Keyed by product name.
 */
export function finderGroups(items: { name: string; group?: string | null }[]): Map<string, string> {
  const own = items.filter((i) => i.group && i.group.trim()).length;
  if (items.length > 0 && own * 2 >= items.length) {
    return new Map(items.map((i) => [i.name, i.group?.trim() || "Other"]));
  }
  return groupsFor(items.map((i) => i.name));
}

/** Group order on the buttons: words A–Z, then groups that are a size ("5kg"), "Other" last. */
export function sortGroups(groups: Iterable<string>): string[] {
  const rank = (g: string) => (g === "Other" ? 2 : /^\d/.test(g) ? 1 : 0);
  return [...new Set(groups)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }));
}

/** How the products show: "list" = rows like the printed price list (name · price · left), "tiles" = big
    buttons with the picture. Remembered on this device. */
export type FinderView = "list" | "tiles";
const VIEW_KEY = "sam.finderView";
export function savedView(): FinderView {
  try { return window.localStorage.getItem(VIEW_KEY) === "tiles" ? "tiles" : "list"; } catch { return "list"; }
}
export function saveView(v: FinderView) {
  try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* convenience only */ }
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
