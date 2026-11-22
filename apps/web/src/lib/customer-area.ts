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
export const lastTown = (s: string | null | undefined): Area | null => {
  const m = (s ?? "").match(TOWN);
  const last = m?.[m.length - 1];
  return last ? (last.toLowerCase() as Area) : null;
};

/**
 * The town a STORE is in (2026-11-22, the owner's rule): the Lipa store is Lipa; Bogs and Lucy, Bahay Tindahan and the
 * Bodega are all Bauan. So any place whose name does not say Lipa (or another town) counts as Bauan.
 */
export function storeArea(storeName: string | null | undefined): Area | null {
  if (!storeName?.trim()) return null;
  return lastTown(storeName) ?? "bauan";
}

/** Lipa, Bauan, or null (not known). */
export function customerArea(c: AreaInfo): Area | null {
  return lastTown(c.name) ?? lastTown(c.address) ?? storeArea(c.addedAt?.name);
}

const az = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
/** A to Z by name, capitals and spaces ignored (2026-11-21). */
export function alphabetical<T extends AreaInfo>(list: T[]): T[] {
  return [...list].sort((a, b) => az(a.name).localeCompare(az(b.name)));
}

/**
 * The list for one area ("" = everyone), A to Z. The customer already chosen always stays, so the box never goes
 * blank.
 */
export function byArea<T extends AreaInfo & { id: string }>(list: T[], area: string, keepId?: string): T[] {
  return alphabetical(area ? list.filter((c) => c.id === keepId || customerArea(c) === area) : list);
}

/** "Lipa" / "Bauan" for the town buttons and tags. */
export const areaLabel = (a: Area | null | undefined) => AREAS.find((x) => x.id === a)?.label ?? "";

/**
 * The name as the customer list shows it, with the town after it when the name does not already say it:
 * "Aling Rosa · Lipa", but "Acel-bauan" stays "Acel-bauan".
 */
export function nameWithTown(c: AreaInfo, fallback = "—"): string {
  const name = c.name?.trim() || fallback;
  const a = customerArea(c);
  return a && !lastTown(c.name) ? `${name} · ${areaLabel(a)}` : name;
}

/** How many customers each area has (for the button labels). */
export function areaCounts(list: AreaInfo[]): Record<Area, number> {
  const n: Record<Area, number> = { lipa: 0, bauan: 0 };
  for (const c of list) { const a = customerArea(c); if (a) n[a]++; }
  return n;
}
