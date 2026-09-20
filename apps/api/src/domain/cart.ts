// Cart revalidation before checkout.
// Rule (AGENTS.md): re-price and revalidate before order creation; never charge a stale total.
// P2a: variant lines re-price from the VARIANT's current price and are dropped when
// the variant is missing/inactive.
// P3c: add-on options are re-priced from the LIVE groups at checkout — a stale
// add-on total is never charged; vanished/deactivated options are dropped.

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

/** P3c: live add-on option (from the store's CURRENT add-on groups). */
export interface FreshAddonOption {
  addonId: string;
  name: string;
  priceMinor: number;
}

/** P3c: the add-on snapshot stored on a cart line (`{ addonId, optionId, name, priceMinor }`). */
export interface CartAddonSnapshot {
  addonId: string;
  optionId: string;
  name: string;
  priceMinor: number;
}

export interface RevalidationResult {
  lines: PricedCartLine[];
  /** price changes already applied to lines; listed so the UI can explain them */
  priceChanges: { productId: string; fromMinor: number; toMinor: number }[];
  /** P3c: add-on option price changes applied; listed so the UI can explain them */
  addonPriceChanges: { productId: string; optionId: string; name: string; fromMinor: number; toMinor: number }[];
  /** P3c: options no longer offered (deactivated/deleted) — cost removed from the line */
  removedAddonOptionIds: string[];
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

/** P3c: re-price a line's add-on snapshot against the live groups. */
function repriceAddons(
  productId: string,
  snapshot: unknown[] | null | undefined,
  freshAddons: Map<string, FreshAddonOption>,
  addonPriceChanges: RevalidationResult["addonPriceChanges"],
  removedAddonOptionIds: string[],
): { addons: unknown[] | null | undefined; addonsTotalMinor: number } {
  if (!snapshot || snapshot.length === 0) {
    return { addons: snapshot, addonsTotalMinor: 0 };
  }
  const rebuilt: unknown[] = [];
  let total = 0;
  for (const raw of snapshot) {
    const a = raw as CartAddonSnapshot;
    const live = a?.optionId ? freshAddons.get(a.optionId) : undefined;
    // Missing, deactivated (filtered out of live groups), or no longer in the same
    // add-on group → the option is dropped and its cost removed.
    if (!live || live.addonId !== a?.addonId) {
      if (a?.optionId) removedAddonOptionIds.push(a.optionId);
      continue;
    }
    if (typeof a?.priceMinor === "number" && live.priceMinor !== a.priceMinor) {
      addonPriceChanges.push({
        productId,
        optionId: a.optionId!,
        name: live.name,
        fromMinor: a.priceMinor,
        toMinor: live.priceMinor,
      });
    }
    rebuilt.push({ addonId: live.addonId, optionId: a.optionId!, name: live.name, priceMinor: live.priceMinor });
    total += live.priceMinor;
  }
  return { addons: rebuilt, addonsTotalMinor: total };
}

export function revalidateCartLines(
  lines: PricedCartLine[],
  freshById: Map<string, FreshProduct>,
  freshVariants: Map<string, FreshVariant> = new Map(),
  freshAddons: Map<string, FreshAddonOption> = new Map(),
): RevalidationResult {
  if (lines.length === 0) {
    throw new CartRevalidationError("cannot revalidate an empty cart");
  }
  const priceChanges: { productId: string; fromMinor: number; toMinor: number }[] = [];
  const addonPriceChanges: RevalidationResult["addonPriceChanges"] = [];
  const removedAddonOptionIds: string[] = [];
  const removedProductIds: string[] = [];
  const kept: PricedCartLine[] = [];

  for (const line of lines) {
    const fresh = freshById.get(line.productId);
    if (!fresh || !fresh.isActive) {
      removedProductIds.push(line.productId);
      continue;
    }

    const addonPricing = repriceAddons(line.productId, line.addons, freshAddons, addonPriceChanges, removedAddonOptionIds);

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
        addonsTotalMinor: addonPricing.addonsTotalMinor,
        addons: addonPricing.addons,
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
      addonsTotalMinor: addonPricing.addonsTotalMinor,
      addons: addonPricing.addons,
    });
  }

  const subtotalMinor = kept.reduce(
    (sum, l) => sum + (l.unitPriceMinor + (l.addonsTotalMinor ?? 0)) * l.quantity,
    0,
  );

  return { lines: kept, priceChanges, addonPriceChanges, removedAddonOptionIds, removedProductIds, subtotalMinor };
}