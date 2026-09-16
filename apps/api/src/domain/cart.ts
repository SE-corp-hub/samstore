// Cart revalidation before checkout.
// Rule (AGENTS.md): re-price and revalidate before order creation; never charge a stale total.
// P2a: variant lines re-price from the VARIANT's current price and are dropped when
// the variant is missing/inactive. Add-on costs are server-priced at add-time and are
// carried through (re-validated against the live groups in the checkout service).

export interface PricedCartLine {
  productId: string;
  variantId?: string | null;
  quantity: number;
  unitPriceMinor: number;
  addonsTotalMinor?: number;
  addons?: unknown[] | null;
}

export interface FreshProduct {
  id: string;
  priceMinor: number;
  isActive: boolean;
}

export interface FreshVariant {
  id: string;
  productId: string;
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
  freshVariants: Map<string, FreshVariant> = new Map(),
): RevalidationResult {
  if (lines.length === 0) {
    throw new CartRevalidationError("cannot revalidate an empty cart");
  }
  const priceChanges: { productId: string; fromMinor: number; toMinor: number }[] = [];
  const removedProductIds: string[] = [];
  const kept: PricedCartLine[] = [];

  for (const line of lines) {
    const fresh = freshById.get(line.productId);
    if (!fresh || !fresh.isActive) {
      removedProductIds.push(line.productId);
      continue;
    }

    // Variant lines price from the VARIANT (own price + availability), not the product.
    if (line.variantId) {
      const v = freshVariants.get(line.variantId);
      if (!v || !v.isActive || v.productId !== line.productId) {
        removedProductIds.push(line.productId);
        continue;
      }
      let unitPriceMinor = line.unitPriceMinor;
      if (v.priceMinor !== line.unitPriceMinor) {
        priceChanges.push({
          productId: line.productId,
          fromMinor: line.unitPriceMinor,
          toMinor: v.priceMinor,
        });
        unitPriceMinor = v.priceMinor;
      }
      kept.push({
        productId: line.productId,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceMinor,
        addonsTotalMinor: line.addonsTotalMinor ?? 0,
        addons: line.addons,
      });
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
    kept.push({
      productId: line.productId,
      quantity: line.quantity,
      unitPriceMinor,
      addonsTotalMinor: line.addonsTotalMinor ?? 0,
      addons: line.addons,
    });
  }

  const subtotalMinor = kept.reduce(
    (sum, l) => sum + (l.unitPriceMinor + (l.addonsTotalMinor ?? 0)) * l.quantity,
    0,
  );

  return { lines: kept, priceChanges, removedProductIds, subtotalMinor };
}