// Human-readable, store-scoped order numbers.
// Legacy format (no prefix configured): <STORE-SLUG-6>-<6-digit sequence> e.g. SAMSTO-000001.
// P3i: with a configured prefix: <PREFIX>-<YYYY>-<6-digit sequence> e.g. PIN-2026-000001.
// The sequence itself is a DB counter (StoreCounter model); this formats it.

export interface OrderNumberFormatter {
  formatOrderNumber(storeSlug: string, seq: number, opts?: { prefix?: string }): string;
}

export class InvalidOrderSeqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOrderSeqError";
  }
}

function cleanPrefix(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatOrderNumber(storeSlug: string, seq: number, opts: { prefix?: string } = {}): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new InvalidOrderSeqError(`seq must be a positive integer, got ${seq}`);
  }
  const configured = cleanPrefix(opts.prefix ?? "");
  const prefix = configured.length > 0 ? configured.slice(0, 6) : cleanPrefix(storeSlug).slice(0, 6);
  if (prefix.length === 0) {
    throw new InvalidOrderSeqError(`storeSlug produced an empty prefix: ${storeSlug}`);
  }
  const padded = String(seq).padStart(6, "0");
  // P3i: configured prefix → PIN-YYYY-NNNNNN (calendar year embedded).
  if (configured.length > 0) {
    return `${prefix}-${new Date().getFullYear()}-${padded}`;
  }
  return `${prefix}-${padded}`;
}