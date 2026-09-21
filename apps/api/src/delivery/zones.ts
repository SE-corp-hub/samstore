// P5a: delivery zone resolution — pure, unit-testable.
// A store's active zones either match the delivery address (fee + ETA), fall back to
// a catch-all zone (cityCode null), or the address is OUT OF COVERAGE. No zones
// configured → the caller keeps the legacy flat fee.

export interface DeliveryZoneLike {
  name: string;
  cityCode: string | null; // PSGC city code; null = catch-all
  barangayCodes: string[];
  feeMinor: number;
  etaMinutes: number;
}

export type ZoneResolution =
  | { resolved: false; legacyFlatFee: boolean }
  | { resolved: true; zone: DeliveryZoneLike };

export function resolveDeliveryZone(
  zones: DeliveryZoneLike[],
  cityCode: string | null,
  barangayCode: string | null,
): ZoneResolution {
  if (zones.length === 0) return { resolved: false, legacyFlatFee: true };
  const match = zones.find(
    (z) =>
      z.cityCode === cityCode &&
      (z.barangayCodes.length === 0 || (barangayCode != null && z.barangayCodes.includes(barangayCode))),
  );
  if (match) return { resolved: true, zone: match };
  const catchAll = zones.find((z) => z.cityCode === null);
  if (catchAll) return { resolved: true, zone: catchAll };
  return { resolved: false, legacyFlatFee: false }; // out of coverage
}