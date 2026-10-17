// Stock book — pure helpers. No DB.
//
// The ledger (StockMovement) writes the balance after every change. This checks, for ONE
// product at ONE location, that the chain holds together and that its last balance equals
// the stock on hand. It tells the owner where a count and the ledger part ways, e.g. a
// location that sold rice its inventory never showed.
//
//   * Reservation-only rows (hold / release a hold) never change stock on hand; they are skipped.
//   * A row with no stored balance (older data) is carried forward by its delta; if nothing
//     came before it, the chain is unknown until the next row that has a balance.

export type LedgerRow = {
  id: string;
  type: string;
  delta: number;
  balanceAfter: number | null;
  documentType: string | null;
  documentId: string | null;
  createdAt: Date;
};

export const RESERVATION_TYPES = ["RESERVE", "RELEASE_RESERVATION"];

export type ChainBreak = {
  rowId: string;
  type: string;
  documentType: string | null;
  documentId: string | null;
  at: Date;
  /** What the balance should have been if the previous balance plus this change was all that happened. */
  expected: number;
  /** What the ledger says it was. */
  actual: number;
  /** actual − expected: stock that appeared (+) or vanished (−) outside the ledger just before this row. */
  gap: number;
};

export type ChainCheck = {
  status: "ok" | "off" | "no_ledger" | "empty";
  onHand: number;
  /** The balance after the newest counted row (null if the ledger never knew one). */
  ledgerBalance: number | null;
  /** onHand − ledgerBalance: positive = the shelf shows more than the ledger explains. */
  difference: number;
  rows: number;
  breaks: ChainBreak[];
};

export function checkChain(rowsAsc: LedgerRow[], onHand: number, ignore: string[] = RESERVATION_TYPES): ChainCheck {
  const rows = rowsAsc.filter((r) => !ignore.includes(r.type));
  if (rows.length === 0) {
    return { status: onHand === 0 ? "empty" : "no_ledger", onHand, ledgerBalance: null, difference: onHand, rows: 0, breaks: [] };
  }
  const breaks: ChainBreak[] = [];
  let prev: number | null = null;
  for (const r of rows) {
    if (r.balanceAfter !== null) {
      if (prev !== null && prev + r.delta !== r.balanceAfter) {
        breaks.push({ rowId: r.id, type: r.type, documentType: r.documentType, documentId: r.documentId, at: r.createdAt, expected: prev + r.delta, actual: r.balanceAfter, gap: r.balanceAfter - (prev + r.delta) });
      }
      prev = r.balanceAfter;
    } else if (prev !== null) {
      prev += r.delta;
    }
  }
  if (prev === null) return { status: "no_ledger", onHand, ledgerBalance: null, difference: onHand, rows: rows.length, breaks };
  const difference = onHand - prev;
  return { status: difference === 0 && breaks.length === 0 ? "ok" : "off", onHand, ledgerBalance: prev, difference, rows: rows.length, breaks };
}

// ───────────────────────── period totals ─────────────────────────

/** The plain-words bucket a ledger row falls into. */
export type Bucket = "purchase" | "transfer_in" | "transfer_out" | "sale" | "resack" | "count_or_writeoff" | "void_or_return" | "other";

export function bucketOf(r: Pick<LedgerRow, "type" | "documentType"> & { delta?: number }): Bucket {
  const d = r.documentType ?? "";
  if (r.type === "VOID_RESTORE" || d === "RETURN") return "void_or_return";
  if (d === "STOCK_IN" || r.type === "RECEIPT" || r.type === "STOCK_IN") return "purchase";
  if (d === "TRANSFER" || d === "RELEASE") return r.type === "TRANSFER_IN" || (r.delta ?? 0) > 0 ? "transfer_in" : "transfer_out";
  if (d === "SALE" || d === "ORDER" || d === "ORDER_EDIT" || d === "PAPER_SLIP" || r.type === "CONSUME") return "sale";
  if (d === "RESACK" || r.type === "CONVERSION_IN" || r.type === "CONVERSION_OUT" || r.type === "MERGE_OUT") return "resack";
  if (d === "COUNT" || d === "WRITE_OFF" || d === "STOCK_SET" || r.type === "ADJUST") return "count_or_writeoff";
  return "other";
}

export type PeriodTotals = {
  opening: number | null;
  closing: number | null;
  inQty: number;
  outQty: number;
  byBucket: Record<Bucket, { inQty: number; outQty: number }>;
};

const emptyBuckets = (): Record<Bucket, { inQty: number; outQty: number }> => ({
  purchase: { inQty: 0, outQty: 0 }, transfer_in: { inQty: 0, outQty: 0 }, transfer_out: { inQty: 0, outQty: 0 }, sale: { inQty: 0, outQty: 0 },
  resack: { inQty: 0, outQty: 0 }, count_or_writeoff: { inQty: 0, outQty: 0 }, void_or_return: { inQty: 0, outQty: 0 }, other: { inQty: 0, outQty: 0 },
});

/**
 * Opening, in, out and closing for rows between `from` (inclusive) and `to` (exclusive).
 * `rowsAsc` is the WHOLE history of one product at one location, oldest first, so the opening
 * balance is the balance after the last row before `from`. opening + in − out = closing whenever the chain holds.
 */
export function periodTotals(rowsAsc: LedgerRow[], from: Date, to: Date, ignore: string[] = RESERVATION_TYPES): PeriodTotals {
  const rows = rowsAsc.filter((r) => !ignore.includes(r.type));
  let running: number | null = null;
  let opening: number | null = null;
  let openingFixed = false;
  const t: PeriodTotals = { opening: null, closing: null, inQty: 0, outQty: 0, byBucket: emptyBuckets() };
  for (const r of rows) {
    if (r.createdAt >= to) break;
    if (r.createdAt >= from && !openingFixed) {
      // No earlier row: the shelf started at this row's balance minus what it moved (so a product that began in this period starts at 0, not "?").
      opening = running !== null ? running : r.balanceAfter !== null ? r.balanceAfter - r.delta : null;
      openingFixed = true;
    }
    running = r.balanceAfter !== null ? r.balanceAfter : running !== null ? running + r.delta : null;
    if (r.createdAt >= from) {
      const b = t.byBucket[bucketOf(r)];
      if (r.delta >= 0) { t.inQty += r.delta; b.inQty += r.delta; } else { t.outQty += -r.delta; b.outQty += -r.delta; }
    }
  }
  if (!openingFixed) opening = running;
  t.opening = opening;
  t.closing = running;
  return t;
}
