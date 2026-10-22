// Rice Ops — the owner's side of counting, after the fact and never blocking:
//   * "Needs a look": counts with a big difference, the same item short again and again, many
//     "Don't know" reasons, and over counts (they add stock from nothing).
//   * "Today's suggested list": about ten items to count — never counted first, fast sellers weekly, the rest monthly.
//   * Count accuracy: the share of items right on the first count, as a weekly trend.
// Pure: rows in, answers out.

const DAY = 86_400_000;

export const REPEAT_TIMES = 3; // short this many times …
export const REPEAT_DAYS = 30; // … in this many days
export const UNKNOWN_LINES = 3; // this many "Don't know" differences in one count

// ───────────────────────────── needs a look ─────────────────────────────

export interface LookLine { productId: string; name: string; leftoverQty: number; valueMinor: number; reason: string | null }
export interface LookCount { id: string; locationId: string; decidedAt: Date; lookStatus: string; lines: LookLine[] }
export interface LookLimits { lookMinor: number; recountMinor: number }
export type FlagKind = "BIG" | "OVER" | "REPEAT" | "UNKNOWN";
export interface Flag { kind: FlagKind; productId: string | null; name: string | null; /** signed: − short, + over */ valueMinor: number | null; times: number | null }

const KIND_ORDER: Record<FlagKind, number> = { BIG: 0, REPEAT: 1, OVER: 2, UNKNOWN: 3 };

/** The flags of every count that nobody has looked at yet (counts already marked OK stay out). Newest first. */
export function needsLook(counts: LookCount[], limits: LookLimits, now: number): { id: string; flags: Flag[] }[] {
  const since = now - REPEAT_DAYS * DAY;
  // How many counts in the last 30 days found each item short at each location.
  const shortTimes = new Map<string, number>();
  for (const c of counts) {
    if (c.decidedAt.getTime() < since) continue;
    for (const l of c.lines) if (l.leftoverQty < 0) shortTimes.set(`${c.locationId}|${l.productId}`, (shortTimes.get(`${c.locationId}|${l.productId}`) ?? 0) + 1);
  }
  const out: { id: string; flags: Flag[]; at: number }[] = [];
  for (const c of counts) {
    if (c.lookStatus !== "NONE") continue;
    const flags: Flag[] = [];
    for (const l of c.lines) {
      if (l.leftoverQty === 0) continue;
      const big = limits.lookMinor > 0 && Math.abs(l.valueMinor) >= limits.lookMinor;
      if (big) flags.push({ kind: "BIG", productId: l.productId, name: l.name, valueMinor: l.valueMinor, times: null });
      else if (l.leftoverQty > 0 && limits.recountMinor > 0 && l.valueMinor >= limits.recountMinor) flags.push({ kind: "OVER", productId: l.productId, name: l.name, valueMinor: l.valueMinor, times: null });
      const times = l.leftoverQty < 0 ? shortTimes.get(`${c.locationId}|${l.productId}`) ?? 0 : 0;
      if (times >= REPEAT_TIMES) flags.push({ kind: "REPEAT", productId: l.productId, name: l.name, valueMinor: l.valueMinor, times });
    }
    const unknown = c.lines.filter((l) => l.leftoverQty !== 0 && l.reason === "UNKNOWN").length;
    if (unknown >= UNKNOWN_LINES) flags.push({ kind: "UNKNOWN", productId: null, name: null, valueMinor: null, times: unknown });
    if (flags.length) out.push({ id: c.id, flags: flags.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || Math.abs(b.valueMinor ?? 0) - Math.abs(a.valueMinor ?? 0)), at: c.decidedAt.getTime() });
  }
  return out.sort((a, b) => b.at - a.at).map(({ id, flags }) => ({ id, flags }));
}

/** ₱1,250.00 (no sign). */
export function pesoPlain(minor: number): string {
  const [whole, cents] = (Math.abs(minor) / 100).toFixed(2).split(".") as [string, string];
  return `₱${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

/** The flag in plain words. */
export function flagText(f: Flag): string {
  switch (f.kind) {
    case "BIG": return `${(f.valueMinor ?? 0) < 0 ? "Short" : "Over"} ${pesoPlain(f.valueMinor ?? 0)} on ${f.name}`;
    case "OVER": return `Over count adds stock: ${f.name} (${pesoPlain(f.valueMinor ?? 0)})`;
    case "REPEAT": return `${f.name} was short ${f.times} times in ${REPEAT_DAYS} days`;
    case "UNKNOWN": return `${f.times} differences marked “Don't know”`;
  }
}

// ───────────────────────────── today's suggested list ─────────────────────────────

export interface SuggestItem { productId: string; name: string; lastCountedAt: Date | null; /** sales in the last 30 days */ sales30: number; onHand: number }
export type SuggestWhy = "NEVER" | "FAST" | "DUE";
export interface Suggestion { productId: string; name: string; why: SuggestWhy; /** days since it was counted (null = never) */ days: number | null }

export const FAST_DUE_DAYS = 7;
export const SLOW_DUE_DAYS = 30;

/** The fast sellers: the top third of the items that sold at all (at least one). */
export function fastSellers(items: Pick<SuggestItem, "productId" | "sales30">[]): Set<string> {
  const sold = items.filter((i) => i.sales30 > 0).sort((a, b) => b.sales30 - a.sales30);
  return new Set(sold.slice(0, Math.max(1, Math.ceil(sold.length / 3))).filter(() => sold.length > 0).map((i) => i.productId));
}

/** About `limit` items to count today: never counted first (best sellers first), then what is overdue. */
export function suggestList(items: SuggestItem[], now: number, limit = 10): Suggestion[] {
  const fast = fastSellers(items);
  const never = items
    .filter((i) => !i.lastCountedAt && (i.onHand > 0 || i.sales30 > 0))
    .sort((a, b) => b.sales30 - a.sales30 || a.name.localeCompare(b.name))
    .map((i): Suggestion => ({ productId: i.productId, name: i.name, why: "NEVER", days: null }));
  const due = items
    .filter((i): i is SuggestItem & { lastCountedAt: Date } => !!i.lastCountedAt)
    .map((i) => {
      const days = Math.floor((now - i.lastCountedAt.getTime()) / DAY);
      const every = fast.has(i.productId) ? FAST_DUE_DAYS : SLOW_DUE_DAYS;
      return { i, days, ratio: days / every, why: (fast.has(i.productId) ? "FAST" : "DUE") as SuggestWhy };
    })
    .filter((x) => x.ratio >= 1 && (x.i.onHand > 0 || x.i.sales30 > 0))
    .sort((a, b) => b.ratio - a.ratio || a.i.name.localeCompare(b.i.name))
    .map((x): Suggestion => ({ productId: x.i.productId, name: x.i.name, why: x.why, days: x.days }));
  return [...never, ...due].slice(0, limit);
}

/** "Never counted" / "Fast seller, counted 9 days ago" / "Counted 40 days ago". */
export function suggestText(s: Pick<Suggestion, "why" | "days">): string {
  if (s.why === "NEVER" || s.days === null) return "Never counted";
  const ago = `counted ${s.days} day${s.days === 1 ? "" : "s"} ago`;
  return s.why === "FAST" ? `Fast seller, ${ago}` : `${ago.charAt(0).toUpperCase()}${ago.slice(1)}`;
}

// ───────────────────────────── count accuracy ─────────────────────────────

export interface AccLine { countedAt: Date; countedQty: number; firstCountedQty: number | null; expectedQty: number }
export interface AccStat { counted: number; right: number; /** whole percent, null when nothing was counted */ pct: number | null }

/** Right the first time: the first number typed matched what the system had. */
export const rightFirst = (l: AccLine): boolean => (l.firstCountedQty ?? l.countedQty) === l.expectedQty;

export function accStat(lines: AccLine[]): AccStat {
  const right = lines.filter(rightFirst).length;
  return { counted: lines.length, right, pct: lines.length ? Math.round((right * 100) / lines.length) : null };
}

/** The last `weeks` weeks, oldest first; week 0 is the most recent 7 days ending at `now`. */
export function weeklyTrend(lines: AccLine[], now: number, weeks = 4): (AccStat & { endsAt: Date })[] {
  const out: (AccStat & { endsAt: Date })[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const end = now - w * 7 * DAY;
    const start = end - 7 * DAY;
    out.push({ ...accStat(lines.filter((l) => l.countedAt.getTime() > start && l.countedAt.getTime() <= end)), endsAt: new Date(end) });
  }
  return out;
}
