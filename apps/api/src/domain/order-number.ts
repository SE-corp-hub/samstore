// Human-readable, store-scoped order numbers.
// Format: <STORE-SLUG-PREFIX>-<6-digit sequence> e.g. SAMSTO-000001
// The sequence itself is a DB counter (StoreCounter model); this formats it.

export interface OrderNumberFormatter {
  formatOrderNumber(storeSlug: string, seq: number): string;
}

export class InvalidOrderSeqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderSeqError";
  }
}

export function formatOrderNumber(storeSlug: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new InvalidOrderSeqError(`seq must be a positive integer, got ${seq}`);
  }
  const prefix = storeSlug
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  if (prefix.length === 0) {
    throw new InvalidOrderSeqError(`storeSlug produced an empty prefix: ${storeSlug}`);
  }
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}