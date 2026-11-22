// Rice Ops M4 — resack arithmetic (pure). Any rice into any rice:
//   1 × Sinandomeng 25 kg → 5 × Sinandomeng 5 kg
//   1 × Sinandomeng 25 kg → 1 × Dinorado 25 kg   (Ibang klase — variety change)
//   1 × sack → loose kilos                       (Buksan ang sako)
// Everything is weighed in grams. The new rice carries the old rice's cost (split by
// weight), so profit stays honest; what is lost is valued at the same cost.

import { DEFAULT_LOSS_TOLERANCE_BP, lossBasisPoints } from "./weight.js";

export class ResackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResackError";
  }
}

export interface WeighedProduct {
  name: string;
  variety?: string | null;
  stockBaseUnit?: string | null;
  stockBaseQuantity?: number | null;
}

/** Grams in `qty` stock units of a product. Only products weighed in grams can be resacked. */
export function gramsOf(p: WeighedProduct, qty: number): number {
  if (!Number.isInteger(qty) || qty < 1) throw new ResackError(`Enter how many ${p.name} (1 or more)`);
  if ((p.stockBaseUnit ?? "").toLowerCase() !== "g" || !p.stockBaseQuantity || p.stockBaseQuantity < 1) {
    throw new ResackError(`Set the weight of ${p.name} first (grams per sack/kilo) in Products`);
  }
  const grams = qty * p.stockBaseQuantity;
  if (!Number.isSafeInteger(grams) || grams > 2_147_483_647) throw new ResackError("The weight is too big");
  return grams;
}

/**
 * Cost of `qty` stock units. Loose rice is stocked in grams but priced and costed PER
 * KILO (plan decision), so its value is grams × cost-per-kg ÷ 1000 (half-up).
 */
export function valueOf(p: WeighedProduct & { costMinor: number }, qty: number): number {
  const loose = (p.stockBaseUnit ?? "").toLowerCase() === "g" && p.stockBaseQuantity === 1;
  const v = loose ? Number((BigInt(qty) * BigInt(p.costMinor) + 500n) / 1000n) : qty * p.costMinor;
  if (!Number.isSafeInteger(v) || v > 2_147_483_647) throw new ResackError("The amount is too big");
  return v;
}

/**
 * The variety of a product: its `variety` field, else its name without the weight words
 * ("Sinandomeng 25 kg" → "sinandomeng", "Sinandomeng 5kg" → "sinandomeng").
 */
export function varietyOf(p: { name: string; variety?: string | null }): string {
  if (p.variety && p.variety.trim()) return p.variety.trim().toLowerCase();
  return p.name
    .toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|kgs|kilo|kilos|g|grams?)\b/g, " ")
    .replace(/\b(?:per\s+kilo|loose|tingi|sako|sack|bag)\b/g, " ")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ResackPlanInput {
  input: { productId: string; name: string; variety?: string | null; grams: number; valueMinor: number };
  /** More rice going in with the first one (2026-11-22: "add another item going in"), e.g. a half-used sack of another rice. */
  moreInputs?: { productId: string; name: string; variety?: string | null; grams: number; valueMinor: number }[];
  outputs: { productId: string; name: string; variety?: string | null; grams: number }[];
  toleranceBp?: number;
}

export interface ResackPlan {
  /** What all the rice going in cost. */
  valueInMinor: number;
  gramsIn: number;
  gramsOut: number;
  lossGrams: number;
  lossBp: number;
  needsApproval: boolean;
  varietyChange: boolean;
  lossValueMinor: number;
  /** Value carried into each output, same order as the outputs; sums to valueIn − lossValue. */
  outputValuesMinor: number[];
}

export function planResack(p: ResackPlanInput): ResackPlan {
  if (p.outputs.length === 0) throw new ResackError("Enter what came out");
  if (p.outputs.length > 10) throw new ResackError("Up to 10 kinds of output only");
  const inputs = [p.input, ...(p.moreInputs ?? [])];
  if (inputs.length > 10) throw new ResackError("Up to 10 kinds going in only");
  const inIds = inputs.map((i) => i.productId);
  if (new Set(inIds).size !== inIds.length) throw new ResackError("Each rice going in can be listed only once");
  for (const i of inputs) {
    if (!Number.isInteger(i.grams) || i.grams < 1) throw new ResackError(`Enter how many ${i.name} go in`);
    if (!Number.isInteger(i.valueMinor) || i.valueMinor < 0) throw new ResackError("invalid input value");
  }
  const gramsIn = inputs.reduce((s, i) => s + i.grams, 0);
  const valueInMinor = inputs.reduce((s, i) => s + i.valueMinor, 0);
  if (!Number.isSafeInteger(gramsIn) || gramsIn > 2_147_483_647 || valueInMinor > 2_147_483_647) throw new ResackError("The weight is too big");
  const gramsOut = p.outputs.reduce((s, o) => {
    if (!Number.isInteger(o.grams) || o.grams < 1) throw new ResackError(`Enter the amount of ${o.name}`);
    return s + o.grams;
  }, 0);
  if (gramsOut > gramsIn) {
    throw new ResackError(`What came out (${gramsOut} g) weighs more than what went in (${gramsIn} g). Weigh it again.`);
  }
  if (inputs.length === 1 && p.outputs.length === 1 && p.outputs[0]!.productId === p.input.productId) {
    throw new ResackError("What went in and what came out are the same — nothing was resacked");
  }
  const lossGrams = gramsIn - gramsOut;
  const tolerance = p.toleranceBp ?? DEFAULT_LOSS_TOLERANCE_BP;
  // Exact comparison (no rounding): loss / in > tolerance / 10 000.
  const needsApproval = lossGrams * 10_000 > tolerance * gramsIn;
  // Two kinds of rice mixed together, or rice that comes out as another kind, is a variety change.
  const inVarieties = new Set(inputs.map((i) => varietyOf(i)));
  const varietyChange = inVarieties.size > 1 || p.outputs.some((o) => !inVarieties.has(varietyOf(o)));

  // Value: the lost part at the inputs' cost; the rest split by weight (largest remainder).
  const valueIn = BigInt(valueInMinor);
  const lossValueMinor = Number((valueIn * BigInt(lossGrams)) / BigInt(gramsIn));
  const carried = valueInMinor - lossValueMinor;
  const raw = p.outputs.map((o) => (BigInt(carried) * BigInt(o.grams)));
  const base = raw.map((r) => Number(r / BigInt(gramsOut)));
  let rest = carried - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: Number(r % BigInt(gramsOut)) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    base[i]! += 1;
    rest -= 1;
  }
  return {
    valueInMinor, gramsIn, gramsOut, lossGrams, lossBp: lossBasisPoints(gramsIn, gramsOut), needsApproval, varietyChange,
    lossValueMinor, outputValuesMinor: base,
  };
}
