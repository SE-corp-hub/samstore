/** Server-derived pack conversion math. Values are all integer minor/base units. */
export interface StockConversionPlanInput {
  sourceQuantity: number;
  outputQuantity: number;
  sourceBaseQuantity: number;
  destinationBaseQuantity: number;
  sourceCostMinor: number;
  wasteReason?: string;
}

export interface StockConversionPlan {
  sourceBaseTotal: number;
  outputBaseTotal: number;
  maxOutputQuantity: number;
  wasteBaseQuantity: number;
  sourceValueMinor: number;
  outputValueMinor: number;
  wasteValueMinor: number;
}

export class InvalidStockConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStockConversionError";
  }
}

/** Compute the maximum possible pack count, short yield, and proportional cost split. */
export function planStockConversion(input: StockConversionPlanInput): StockConversionPlan {
  const {
    sourceQuantity,
    outputQuantity,
    sourceBaseQuantity,
    destinationBaseQuantity,
    sourceCostMinor,
  } = input;
  for (const [name, value] of [
    ["sourceQuantity", sourceQuantity],
    ["outputQuantity", outputQuantity],
    ["sourceBaseQuantity", sourceBaseQuantity],
    ["destinationBaseQuantity", destinationBaseQuantity],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new InvalidStockConversionError(`${name} must be a positive integer`);
  }
  if (!Number.isInteger(sourceCostMinor) || sourceCostMinor < 0) {
    throw new InvalidStockConversionError("sourceCostMinor must be a non-negative integer");
  }

  const sourceBaseTotal = sourceQuantity * sourceBaseQuantity;
  const outputBaseTotal = outputQuantity * destinationBaseQuantity;
  const maxOutputQuantity = Math.floor(sourceBaseTotal / destinationBaseQuantity);
  if (outputQuantity > maxOutputQuantity || outputBaseTotal > sourceBaseTotal) {
    throw new InvalidStockConversionError(`output exceeds available contents; maximum is ${maxOutputQuantity}`);
  }

  const wasteBaseQuantity = sourceBaseTotal - outputBaseTotal;
  if (wasteBaseQuantity > 0 && (input.wasteReason ?? "").trim().length < 3) {
    throw new InvalidStockConversionError("a reason is required when conversion output leaves waste or loss");
  }

  const sourceValueMinor = sourceQuantity * sourceCostMinor;
  if (!Number.isSafeInteger(sourceValueMinor) || sourceValueMinor > 2_147_483_647) {
    throw new InvalidStockConversionError("source stock value is too large to record safely");
  }
  const wasteValueMinor = Number((BigInt(sourceValueMinor) * BigInt(wasteBaseQuantity)) / BigInt(sourceBaseTotal));
  return {
    sourceBaseTotal,
    outputBaseTotal,
    maxOutputQuantity,
    wasteBaseQuantity,
    sourceValueMinor,
    outputValueMinor: sourceValueMinor - wasteValueMinor,
    wasteValueMinor,
  };
}
