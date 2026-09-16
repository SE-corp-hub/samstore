// Pricing engine — pure integer-minor-unit math.
// Rule (AGENTS.md): server-authoritative pricing; client-supplied totals are rejected.

export interface PriceLine {
  unitPriceMinor: number;
  quantity: number;
}

export interface OrderTotalsInput {
  lines: PriceLine[];
  deliveryFeeMinor?: number;
  discountMinor?: number;
}

export interface OrderTotals {
  subtotalMinor: number;
  deliveryFeeMinor: number;
  discountMinor: number;
  totalMinor: number;
}

export class InvalidPriceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPriceInputError";
  }
}

export function computeOrderTotals(input: OrderTotalsInput): OrderTotals {
  if (input.lines.length === 0) {
    throw new InvalidPriceInputError("Order must contain at least one line");
  }

  const deliveryFeeMinor = input.deliveryFeeMinor ?? 0;
  const discountMinor = input.discountMinor ?? 0;

  if (!Number.isInteger(deliveryFeeMinor) || deliveryFeeMinor < 0) {
    throw new InvalidPriceInputError("deliveryFeeMinor must be a non-negative integer");
  }
  if (!Number.isInteger(discountMinor) || discountMinor < 0) {
    throw new InvalidPriceInputError("discountMinor must be a non-negative integer");
  }

  let subtotalMinor = 0;
  for (const line of input.lines) {
    if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
      throw new InvalidPriceInputError(
        `unitPriceMinor must be a non-negative integer, got ${line.unitPriceMinor}`,
      );
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new InvalidPriceInputError(
        `quantity must be a positive integer, got ${line.quantity}`,
      );
    }
    // Integer math in minor units; intermediate values stay well under 2^53.
    subtotalMinor += line.unitPriceMinor * line.quantity;
  }

  const totalMinor = subtotalMinor - discountMinor + deliveryFeeMinor;
  if (totalMinor < 0) {
    throw new InvalidPriceInputError("Discount exceeds subtotal plus delivery fee");
  }

  return {
    subtotalMinor,
    deliveryFeeMinor,
    discountMinor,
    totalMinor,
  };
}

/** Formatting helper — currency rendering stays client-side; this is used for order numbers only. */
export function formatMinorUnits(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) {
    throw new InvalidPriceInputError("formatMinorUnits expects a non-negative integer");
  }
  const whole = Math.floor(minor / 100).toString();
  const frac = (minor % 100).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}