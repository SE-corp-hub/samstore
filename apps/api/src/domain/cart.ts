// Cart revalidation before checkout.
// Rule (AGENTS.md): re-price and revalidate before order creation; never charge a stale total.

export interface PricedCartLine {
  productId: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface FreshProduct {
  id: string;
  priceMinor: number;
  isActive: boolean;
}

export interface RevalidationResult {
  lines: PricedCartLine[];
  /** price changes already applied to lines; listed so the UI can explain them */
  priceChanges: { productId: string; fromMinor: number; toMinor: number }[];
  /** inactive or vanished products dropped from the cart */
  removedProductIds: string[];
  subtotalMinor: number;
}

export class CartRevalidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartRevalidationError";
  }
}

export function revalidateCartLines(
  lines: PricedCartLine[],
  freshById: Map<string, FreshProduct>,
): RevalidationResult {
  if (lines.length === 0) {
    throw new CartRevalidationError("cannot revalidate an empty cart");
  }
  const priceChanges: { productId: string; fromMinor: number; toMinor: number }[] = [];
  const removedProductIds: string[] = [];
  const kept: PricedCartLine[] = [];

  for (const line of lines) {
    const fresh = freshById.get(line.productId);
    if (!fresh) {
      removedProductIds.push(line.productId);
      continue;
    }
    if (!fresh.isActive) {
      removedProductIds.push(line.productId);
      continue;
    }

    let unitPriceMinor = line.unitPriceMinor;
    if (fresh.priceMinor !== line.unitPriceMinor) {
      priceChanges.push({
        productId: line.productId,
        fromMinor: line.unitPriceMinor,
        toMinor: fresh.priceMinor,
      });
      unitPriceMinor = fresh.priceMinor;
    }
    kept.push({ productId: line.productId, quantity: line.quantity, unitPriceMinor });
  }

  const subtotalMinor = kept.reduce(
    (sum, l) => sum + l.unitPriceMinor * l.quantity,
    0,
  );

  return { lines: kept, priceChanges, removedProductIds, subtotalMinor };
}