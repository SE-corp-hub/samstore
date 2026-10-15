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
  if (!Number.isInteger(qty) || qty < 1) throw new ResackError(`Ilagay ang bilang ng ${p.name} (1 pataas)`);
  if ((p.stockBaseUnit ?? "").toLowerCase() !== "g" || !p.stockBaseQuantity || p.stockBaseQuantity < 1) {
    throw new ResackError(`Itakda muna ang timbang ng ${p.name} (gramo bawat sako/kilo) sa Products`);
  }
  const grams = qty * p.stockBaseQuantity;
  if (!Number.isSafeInteger(grams) || grams > 2_147_483_647) throw new ResackError("Masyadong malaki ang timbang");
  return grams;
}

/**
 * Cost of `qty` stock units. Loose rice is stocked in grams but priced and costed PER
 * KILO (plan decision), so its value is grams × cost-per-kg ÷ 1000 (half-up).
 */
export function valueOf(p: WeighedProduct & { costMinor: number }, qty: number): number {
  const loose = (p.stockBaseUnit ?? "").toLowerCase() === "g" && p.stockBaseQuantity === 1;
  const v = loose ? Number((BigInt(qty) * BigInt(p.costMinor) + 500n) / 1000n) : qty * p.costMinor;
  if (!Number.isSafeInteger(v) || v > 2_147_483_647) throw new ResackError("Masyadong malaki ang halaga");
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
  outputs: { productId: string; name: string; variety?: string | null; grams: number }[];
  toleranceBp?: number;
}

export interface ResackPlan {
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
  if (p.outputs.length === 0) throw new ResackError("Ilagay kung ano ang lumabas");
  if (p.outputs.length > 10) throw new ResackError("Hanggang 10 uri lang ng lalabas");
  const gramsIn = p.input.grams;
  if (!Number.isInteger(gramsIn) || gramsIn < 1) throw new ResackError("Walang pumasok na bigas");
  if (!Number.isInteger(p.input.valueMinor) || p.input.valueMinor < 0) throw new ResackError("invalid input value");
  const gramsOut = p.outputs.reduce((s, o) => {
    if (!Number.isInteger(o.grams) || o.grams < 1) throw new ResackError(`Ilagay ang dami ng ${o.name}`);
    return s + o.grams;
  }, 0);
  if (gramsOut > gramsIn) {
    throw new ResackError(`Mas mabigat ang lumabas (${gramsOut} g) kaysa pumasok (${gramsIn} g). Timbangin ulit.`);
  }
  if (p.outputs.length === 1 && p.outputs[0]!.productId === p.input.productId) {
    throw new ResackError("Pareho ang pumasok at lumabas — walang resack na nangyari");
  }
  const lossGrams = gramsIn - gramsOut;
  const tolerance = p.toleranceBp ?? DEFAULT_LOSS_TOLERANCE_BP;
  // Exact comparison (no rounding): loss / in > tolerance / 10 000.
  const needsApproval = lossGrams * 10_000 > tolerance * gramsIn;
  const inVariety = varietyOf(p.input);
  const varietyChange = p.outputs.some((o) => varietyOf(o) !== inVariety);

  // Value: the lost part at the input's cost; the rest split by weight (largest remainder).
  const valueIn = BigInt(p.input.valueMinor);
  const lossValueMinor = Number((valueIn * BigInt(lossGrams)) / BigInt(gramsIn));
  const carried = p.input.valueMinor - lossValueMinor;
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
    gramsIn, gramsOut, lossGrams, lossBp: lossBasisPoints(gramsIn, gramsOut), needsApproval, varietyChange,
    lossValueMinor, outputValuesMinor: base,
  };
}
