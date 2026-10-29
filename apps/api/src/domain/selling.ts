// Rice Ops M5 — pure rules for Benta (counter sale). No DB here.
//
//   * A sack/pack sells by piece: line = price × count.
//   * Loose rice (stocked in grams, priced per kilo) sells by KILO (line from grams,
//     rounded once) or by PESO (the customer pays exactly the pesos asked; grams
//     round down — domain/weight.ts).
//   * The price is the selling location's own price, else the main price.
//   * A sale's idempotency key is scoped to the store, so a double-tap (or a retry
//     after a dropped signal) makes ONE sale.
//   * A paper slip keeps its real time: not in the future, not older than 31 days.

import { createHash } from "node:crypto";
import { amountForGrams, gramsForAmount, parseKilos } from "./weight.js";

export class SellingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SellingError";
  }
}

export type SoldBy = "PIECE" | "KILO" | "PESO";

export interface SellableProduct {
  name: string;
  priceMinor: number;
  stockBaseUnit: string | null;
  stockBaseQuantity: number | null;
}

/** Loose rice: stocked in grams (1 stock unit = 1 g), priced per kilo. */
export function isLoose(p: Pick<SellableProduct, "stockBaseUnit" | "stockBaseQuantity">): boolean {
  return (p.stockBaseUnit ?? "").toLowerCase() === "g" && p.stockBaseQuantity === 1;
}

export interface LineAsk {
  /** Pieces (sacks/packs). */
  quantity?: unknown;
  /** Loose by weight: kilos as typed ("1.25") … */
  kilos?: unknown;
  /** … or grams (integer). */
  grams?: unknown;
  /** Loose by peso: centavos the customer asked for. */
  amountMinor?: unknown;
}

export interface PricedLine {
  soldBy: SoldBy;
  /** Stock units that leave the shelf: pieces, or grams for loose rice. */
  stockQty: number;
  /** Grams in the line (loose lines; sacks with a known weight). */
  grams: number | null;
  /** Price per piece, or per kilo for loose rice. */
  unitPriceMinor: number;
  lineTotalMinor: number;
  enteredAmountMinor: number | null;
}

const MAX_PIECES = 999;
const MAX_LINE_MINOR = 100_000_000; // ₱1,000,000 per line — anything bigger is a typo

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Price one line at a unit price (per piece, or per kilo for loose rice). */
export function priceLine(product: SellableProduct, unitPriceMinor: number, ask: LineAsk): PricedLine {
  if (!isInt(unitPriceMinor) || unitPriceMinor <= 0) throw new SellingError(`${product.name} has no price`);
  if (isLoose(product)) {
    const given = [ask.kilos, ask.grams, ask.amountMinor].filter((v) => v !== undefined && v !== null && v !== "").length;
    if (given !== 1) throw new SellingError(`${product.name}: kilos or pesos? Enter only one`);
    if (ask.amountMinor !== undefined && ask.amountMinor !== null && ask.amountMinor !== "") {
      if (!isInt(ask.amountMinor) || ask.amountMinor <= 0) throw new SellingError("Enter the amount in pesos");
      if (ask.amountMinor > MAX_LINE_MINOR) throw new SellingError("The amount is too large");
      let grams: number;
      try {
        grams = gramsForAmount(ask.amountMinor, unitPriceMinor);
      } catch {
        throw new SellingError(`₱${(ask.amountMinor / 100).toFixed(2)} is not enough for even 1 gram of ${product.name}`);
      }
      return { soldBy: "PESO", stockQty: grams, grams, unitPriceMinor, lineTotalMinor: ask.amountMinor, enteredAmountMinor: ask.amountMinor };
    }
    let grams: number;
    if (ask.grams !== undefined && ask.grams !== null && ask.grams !== "") {
      if (!isInt(ask.grams) || ask.grams <= 0) throw new SellingError("Enter the weight");
      grams = ask.grams;
    } else {
      try {
        grams = parseKilos(String(ask.kilos));
      } catch {
        throw new SellingError(`"${String(ask.kilos)}" is not a weight in kilos (e.g. 1.25)`);
      }
    }
    const total = amountForGrams(grams, unitPriceMinor);
    if (total > MAX_LINE_MINOR) throw new SellingError("The weight is too large");
    return { soldBy: "KILO", stockQty: grams, grams, unitPriceMinor, lineTotalMinor: total, enteredAmountMinor: null };
  }
  if (ask.kilos !== undefined || ask.grams !== undefined || ask.amountMinor !== undefined) {
    throw new SellingError(`${product.name} is sold by the piece or sack`);
  }
  if (!isInt(ask.quantity) || ask.quantity <= 0) throw new SellingError(`How many ${product.name}?`);
  if (ask.quantity > MAX_PIECES) throw new SellingError("Too many — up to 999 per line");
  const total = unitPriceMinor * ask.quantity;
  if (total > MAX_LINE_MINOR) throw new SellingError("The amount is too large");
  const grams = (product.stockBaseUnit ?? "").toLowerCase() === "g" && product.stockBaseQuantity ? product.stockBaseQuantity * ask.quantity : null;
  return { soldBy: "PIECE", stockQty: ask.quantity, grams, unitPriceMinor, lineTotalMinor: total, enteredAmountMinor: null };
}

/** A location's selling price for a product: its own price if set, else the main price. */
export function priceAt(mainPriceMinor: number, locationPriceMinor: number | null | undefined): number {
  return locationPriceMinor ?? mainPriceMinor;
}

/**
 * The stored idempotency key for a counter sale: sha256 over the store and the raw key,
 * so two stores can never collide and the raw key is never stored.
 */
export function saleKey(storeId: string, raw: unknown): string {
  if (typeof raw !== "string") throw new SellingError("idempotencyKey is required");
  const t = raw.trim();
  if (t.length < 8 || t.length > 128) throw new SellingError("idempotencyKey must be 8–128 characters");
  return createHash("sha256").update(`sam-store:benta:v1:${storeId}:${t}`).digest("hex");
}

export const PAPER_SLIP_MAX_AGE_DAYS = 31;

/** Validate an encoded paper slip; returns the real time it happened. */
export function checkPaperSlip(slip: { slipNo?: unknown; occurredAt?: unknown }, now: Date): { slipNo: string; occurredAt: Date } {
  const slipNo = typeof slip.slipNo === "string" ? slip.slipNo.trim().toUpperCase() : "";
  if (!/^[A-Z0-9][A-Z0-9-]{0,19}$/.test(slipNo)) throw new SellingError("Enter the paper slip number (e.g. 0123)");
  const when = typeof slip.occurredAt === "string" ? new Date(slip.occurredAt) : null;
  if (!when || Number.isNaN(when.getTime())) throw new SellingError("Enter the date and time written on the paper slip");
  if (when.getTime() > now.getTime() + 5 * 60_000) throw new SellingError("The paper slip time cannot be in the future");
  if (now.getTime() - when.getTime() > PAPER_SLIP_MAX_AGE_DAYS * 86_400_000) {
    throw new SellingError(`The paper slip is more than ${PAPER_SLIP_MAX_AGE_DAYS} days old — ask the owner to fix it`);
  }
  return { slipNo, occurredAt: when };
}

/** A sale made with no signal waits on the tablet; it may reach the server hours later. */
export const OFFLINE_SALE_MAX_AGE_DAYS = 3;

/**
 * When a sale really happened, as the tablet clock saw it. Used only when it is in the past and
 * at most 3 days old; anything else (missing, garbage, future, too old) means "now", as before.
 */
export function offlineSoldAt(soldAt: unknown, now: Date): Date | null {
  const when = typeof soldAt === "string" ? new Date(soldAt) : null;
  if (!when || Number.isNaN(when.getTime())) return null;
  const age = now.getTime() - when.getTime();
  if (age < 60_000 || age > OFFLINE_SALE_MAX_AGE_DAYS * 86_400_000) return null;
  return when;
}

export type ManualSoldAs = "SACK" | "KILO" | "PIECE";

export interface ManualItemAsk {
  name?: unknown;
  soldAs?: unknown;
  /** SACK only: grams in one sack (25 kg = 25000). */
  gramsPerSack?: unknown;
  priceMinor?: unknown;
  costMinor?: unknown;
  /** What is on hand now: sacks/pieces, or grams for KILO. */
  openingQty?: unknown;
}

export interface ManualItemPlan {
  name: string;
  soldAs: ManualSoldAs;
  stockBaseUnit: string | null;
  stockBaseQuantity: number | null;
  soldByWeight: boolean;
  stockConversionFamily: string | null;
  priceMinor: number;
  costMinor: number;
  openingQty: number;
}

/** Bagong item: a product added at the counter. Rice (sack/kilo) joins the "Bigas" family. */
export function planManualItem(ask: ManualItemAsk): ManualItemPlan {
  const name = typeof ask.name === "string" ? ask.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 80) throw new SellingError("Enter the name (2–80 letters)");
  const soldAs = ask.soldAs;
  if (soldAs !== "SACK" && soldAs !== "KILO" && soldAs !== "PIECE") throw new SellingError("Sack, kilo or piece?");
  if (!isInt(ask.priceMinor) || ask.priceMinor <= 0 || ask.priceMinor > MAX_LINE_MINOR) throw new SellingError("Enter the price");
  if (!isInt(ask.costMinor) || ask.costMinor < 0 || ask.costMinor > MAX_LINE_MINOR) throw new SellingError("Enter the cost (0 if unknown)");
  if (!isInt(ask.openingQty) || ask.openingQty <= 0) throw new SellingError("How many are on hand now? (needed to sell it)");
  if (soldAs === "SACK") {
    if (!isInt(ask.gramsPerSack) || ask.gramsPerSack < 100 || ask.gramsPerSack > 100_000) throw new SellingError("How many kilos in one sack?");
    if (ask.openingQty > 100_000) throw new SellingError("Too many");
    return { name, soldAs, stockBaseUnit: "g", stockBaseQuantity: ask.gramsPerSack, soldByWeight: false, stockConversionFamily: "Bigas", priceMinor: ask.priceMinor, costMinor: ask.costMinor, openingQty: ask.openingQty };
  }
  if (soldAs === "KILO") {
    if (ask.openingQty > 100_000_000) throw new SellingError("Too many");
    return { name, soldAs, stockBaseUnit: "g", stockBaseQuantity: 1, soldByWeight: true, stockConversionFamily: "Bigas", priceMinor: ask.priceMinor, costMinor: ask.costMinor, openingQty: ask.openingQty };
  }
  if (ask.openingQty > 100_000) throw new SellingError("Too many");
  return { name, soldAs, stockBaseUnit: null, stockBaseQuantity: null, soldByWeight: false, stockConversionFamily: null, priceMinor: ask.priceMinor, costMinor: ask.costMinor, openingQty: ask.openingQty };
}

/**
 * Merging a manual item into an existing product converts its stock by weight.
 * Returns the target units, or throws when the units don't divide evenly.
 */
export function mergeQuantity(
  from: { name: string; stockBaseUnit: string | null; stockBaseQuantity: number | null },
  to: { name: string; stockBaseUnit: string | null; stockBaseQuantity: number | null },
  qty: number,
): number {
  if (qty === 0) return 0;
  const fromW = (from.stockBaseUnit ?? "").toLowerCase() === "g" ? from.stockBaseQuantity : null;
  const toW = (to.stockBaseUnit ?? "").toLowerCase() === "g" ? to.stockBaseQuantity : null;
  if (!fromW && !toW) return qty; // both by piece
  if (!fromW || !toW) throw new SellingError(`${from.name} and ${to.name} do not use the same measure`);
  const grams = fromW * qty;
  if (grams % toW !== 0) throw new SellingError(`${from.name} stock does not make a whole ${to.name} — resack first`);
  return grams / toW;
}

/** "Only 1 Sinandomeng 25 kg left at Store 2. Lower the amount, or take from WH (has 40)." — errors say what to do. */
export function shortMessage(input: {
  productName: string;
  loose: boolean;
  available: number;
  here: string;
  elsewhere: { name: string; available: number }[];
}): string {
  const fmt = (n: number) => (input.loose ? `${(n / 1000).toLocaleString("en-PH", { maximumFractionDigits: 3 })} kg` : `${n}`);
  const head = input.available > 0 ? `Only ${fmt(input.available)} ${input.productName} left at ${input.here}.` : `No ${input.productName} left at ${input.here}.`;
  const best = input.elsewhere.filter((e) => e.available > 0).sort((a, b) => b.available - a.available)[0];
  return best ? `${head} Lower the amount, or take from ${best.name} (has ${fmt(best.available)}).` : `${head} Lower the amount, or count again.`;
}
