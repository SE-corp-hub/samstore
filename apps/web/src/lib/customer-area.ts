// 2026-11-21: "Lipa or Bauan" on the POS and Pre-order customer pickers. The area is the TOWN the customer is from,
// read from what the app already keeps (no new field): the name ("Acel-bauan"), else the address, else the store
// they were added at ("Made at" Lipa). The last town word in the name wins, so "Lipa/Samrice-bauan" is Bauan.

export const AREAS = [
  { id: "lipa", label: "Lipa" },
  { id: "bauan", label: "Bauan" },
] as const;
export type Area = (typeof AREAS)[number]["id"];

export interface AreaInfo {
  name?: string | null;
  address?: string | null;
  addedAt?: { name: string } | null;
}

const TOWN = /lipa|bauan/gi;
const lastTown = (s: string | null | undefined): Area | null => {
  const m = (s ?? "").match(TOWN);
  const last = m?.[m.length - 1];
  return last ? (last.toLowerCase() as Area) : null;
};

/** Lipa, Bauan, or null (not known). */
export function customerArea(c: AreaInfo): Area | null {
  return lastTown(c.name) ?? lastTown(c.address) ?? lastTown(c.addedAt?.name);
}

/** The list for one area ("" = everyone). The customer already chosen always stays, so the box never goes blank. */
export function byArea<T extends AreaInfo & { id: string }>(list: T[], area: string, keepId?: string): T[] {
  if (!area) return list;
  return list.filter((c) => c.id === keepId || customerArea(c) === area);
}

/** How many customers each area has (for the button labels). */
export function areaCounts(list: AreaInfo[]): Record<Area, number> {
  const n: Record<Area, number> = { lipa: 0, bauan: 0 };
  for (const c of list) { const a = customerArea(c); if (a) n[a]++; }
  return n;
}
