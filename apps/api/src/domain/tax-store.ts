// M4 — the ONE place an order write reads tax configuration + product exemptions.
//
// Every money path (POS sale, POS hold completion, checkout, admin order edit) calls this so the
// frozen VAT breakdown on an order can never drift from the engine's rules.

import { prisma } from "../persistence/prisma-repositories.js";
import { computeTax, taxColumns, taxConfigFrom, type TaxConfig } from "./tax.js";

export interface TaxOrderLine {
  productId?: string | null;
  lineTotalMinor: number;
}

export interface FrozenTax {
  vatableMinor: number;
  vatMinor: number;
  vatExemptMinor: number;
  vatRateBp: number;
}

/**
 * Read the store's VAT settings + the products' exemption flags, then freeze the breakdown.
 *
 * `settingsOverride` lets a caller that already loaded the store's settings (checkout) skip the
 * read. Queries are sequential on purpose: the pooled connection cap makes parallel reads the
 * thing that trips `EMAXCONNSESSION` under load.
 */
export async function taxColumnsFor(
  storeId: string,
  lines: TaxOrderLine[],
  opts: {
    discountMinor?: number;
    deliveryFeeMinor?: number;
    settingsOverride?: Partial<{ vatEnabled: boolean; vatRateBp: number; pricesIncludeVat: boolean }> | null;
    configOverride?: TaxConfig;
    /** A store's first-ever order may precede its settings row. */
    client?: typeof prisma;
  } = {},
): Promise<FrozenTax> {
  const client = opts.client ?? prisma;

  let config: TaxConfig;
  if (opts.configOverride) {
    config = opts.configOverride;
  } else if (opts.settingsOverride) {
    config = taxConfigFrom(opts.settingsOverride);
  } else {
    const settings = await client.storeSettings.findUnique({
      where: { storeId },
      select: { vatEnabled: true, vatRateBp: true, pricesIncludeVat: true },
    });
    config = taxConfigFrom(settings);
  }

  const ids = [...new Set(lines.map((l) => l.productId).filter((x): x is string => !!x))];
  const exempt = new Set<string>();
  if (ids.length > 0) {
    const rows = await client.product.findMany({ where: { storeId, id: { in: ids } }, select: { id: true, taxExempt: true } });
    for (const r of rows) if (r.taxExempt) exempt.add(r.id);
  }

  const breakdown = computeTax(
    lines.map((l) => ({ lineTotalMinor: l.lineTotalMinor, taxExempt: l.productId ? exempt.has(l.productId) : false })),
    config,
    { discountMinor: opts.discountMinor ?? 0, deliveryFeeMinor: opts.deliveryFeeMinor ?? 0 },
  );
  return taxColumns(breakdown);
}