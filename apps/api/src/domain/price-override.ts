// Counter price override — pure rules shared by the POS review step and the
// pre-order edit modal.
//
// Default: the catalog price is authoritative and the client cannot influence
// money. An override is an explicit, BOUNDED, REASONED deviation that is
// recorded on the order item, so a receipt or a later audit can explain a price
// that does not match the catalog. Bounds and the reason requirement are decided
// server-side here — the UI only mirrors them.

/** Hard ceiling for a single overridden line: ₱1,000,000.00. */
export const MAX_OVERRIDE_PRICE_MINOR = 100_000_000;
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 140;

export class PriceOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceOverrideError";
  }
}

export interface ResolvedLinePrice {
  /** The price the line is actually sold at. */
  unitPriceMinor: number;
  /** What the catalog says, kept for the audit trail. */
  catalogUnitPriceMinor: number;
  /** True only when the sale price deviates from the catalog price. */
  overridden: boolean;
  reason: string | null;
}

const pesos = (minor: number) => (minor / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Resolve one line's price. With no override the catalog price wins. An
 * override that matches the catalog is treated as "no override" so a stray
 * value can never mark a line as manually adjusted. Any real deviation needs a
 * 3–140 character reason.
 */
export function resolveLinePrice(input: {
  catalogUnitPriceMinor: number;
  override?: number | null;
  reason?: string | null;
}): ResolvedLinePrice {
  const catalog = input.catalogUnitPriceMinor;
  if (!Number.isInteger(catalog) || catalog < 0) {
    throw new PriceOverrideError("Catalog price is invalid — refresh and try again");
  }

  const override = input.override;
  if (override === undefined || override === null) {
    return { unitPriceMinor: catalog, catalogUnitPriceMinor: catalog, overridden: false, reason: null };
  }
  if (!Number.isInteger(override) || override < 0) {
    throw new PriceOverrideError("Price must be a whole number of pesos (₱0.00 or more)");
  }
  if (override > MAX_OVERRIDE_PRICE_MINOR) {
    throw new PriceOverrideError(`Price cannot be more than ₱${pesos(MAX_OVERRIDE_PRICE_MINOR)}`);
  }
  if (override === catalog) {
    return { unitPriceMinor: catalog, catalogUnitPriceMinor: catalog, overridden: false, reason: null };
  }

  const reason = (input.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new PriceOverrideError("A reason is required when the price differs from the catalog price");
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new PriceOverrideError(`Price-change reason must be ${MAX_REASON_LENGTH} characters or fewer`);
  }
  return { unitPriceMinor: override, catalogUnitPriceMinor: catalog, overridden: true, reason };
}
