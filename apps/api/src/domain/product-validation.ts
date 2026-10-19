// Product admin validation — pure functions, unit-testable.

export interface ProductInput {
  name: string;
  sku: string;
  priceMinor: number;
  /** Optional acquisition cost per sellable unit, in minor currency units. */
  costMinor?: number;
  stock?: number;
  categorySlug?: string | null;
  /** New category to create atomically with a new product. */
  categoryName?: string | null;
  /** Standardized contents per sellable unit, for safe stock conversion. */
  stockBaseUnit?: string | null;
  stockBaseQuantity?: number | null;
  /** Conversion family prevents unrelated same-unit goods from being transformed. */
  stockConversionFamily?: string | null;
  /** false = sells at any time, no stock check or movement. Default true. */
  trackStock?: boolean;
  description?: string | null;
  isActive?: boolean;
  /** M4: a VAT-exempt product (basic/zero-rated goods) — reported as non-VAT sales. */
  taxExempt?: boolean;
  /** M5: scannable barcode (store-scoped unique; absent = unscanned item). */
  barcode?: string | null;
  /** M5: display unit, e.g. "pc", "pack", "kilo", "bottle". */
  unit?: string | null;
  /** M5: per-kilo item (decimal quantity deferred — integer-only this module). */
  soldByWeight?: boolean;
  /** P3d: show in the storefront "Featured" section. */
  featured?: boolean;
  /** P3d: free-form display tags (e.g. ["new", "best seller"]), max 20 × 40 chars. */
  tags?: string[];
  /** P3d: same-store product ids shown as "You may also like" (replace-all, max 12). */
  relatedProductIds?: string[];
  /** P3d: same-store product ids shown as upsell/"Upgrade" (replace-all, max 12). */
  upsellProductIds?: string[];
  /** P3f: quantity-on-hand at/below which the item is flagged LOW stock. */
  reorderThreshold?: number;
}

export type ProductValidation = { ok: true } | { ok: false; errors: string[] };

export function validateProductInput(input: ProductInput): ProductValidation {
  const errors: string[] = [];

  if (!input.name || input.name.trim().length < 2) {
    errors.push("name must be at least 2 characters");
  } else if (input.name.length > 120) {
    errors.push("name must be at most 120 characters");
  }

  if (!input.sku || input.sku.trim().length < 2) {
    errors.push("sku is required (min 2 characters)");
  } else if (input.sku.length > 60) {
    errors.push("sku must be at most 60 characters");
  }

  if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0) {
    errors.push("priceMinor must be a non-negative integer");
  }

  if (input.costMinor !== undefined && (!Number.isInteger(input.costMinor) || input.costMinor < 0)) {
    errors.push("costMinor must be a non-negative integer");
  }

  if (input.categoryName !== undefined && input.categoryName !== null) {
    const categoryName = input.categoryName.trim();
    if (categoryName.length < 2 || categoryName.length > 80) {
      errors.push("categoryName must be 2-80 characters");
    } else if (!slugify(categoryName)) {
      errors.push("categoryName must include letters or numbers");
    }
  }
  if (input.categoryName?.trim() && input.categorySlug?.trim()) {
    errors.push("provide categoryName or categorySlug, not both");
  }

  const stockBaseUnit = input.stockBaseUnit?.trim() ?? "";
  const hasStockBaseQuantity = input.stockBaseQuantity !== undefined && input.stockBaseQuantity !== null;
  const stockConversionFamily = input.stockConversionFamily?.trim() ?? "";
  if (stockBaseUnit && !["g", "ml", "each"].includes(stockBaseUnit)) {
    errors.push("stockBaseUnit must be g, ml, or each");
  }
  if (hasStockBaseQuantity && (!Number.isInteger(input.stockBaseQuantity) || (input.stockBaseQuantity ?? 0) < 1 || (input.stockBaseQuantity ?? 0) > 1_000_000_000)) {
    errors.push("stockBaseQuantity must be an integer from 1 to 1000000000");
  }
  if (hasStockBaseQuantity && !stockBaseUnit) errors.push("stockBaseUnit is required when stockBaseQuantity is set");
  if (stockConversionFamily && (stockConversionFamily.length < 2 || stockConversionFamily.length > 60 || !slugify(stockConversionFamily))) {
    errors.push("stockConversionFamily must be 2-60 slugifiable characters");
  }
  if (Boolean(stockBaseUnit) !== Boolean(stockConversionFamily)) {
    errors.push("stockBaseUnit and stockConversionFamily must be provided together");
  }

  if (input.stock !== undefined) {
    if (!Number.isInteger(input.stock) || input.stock < 0) {
      errors.push("stock must be a non-negative integer");
    }
  }

  if (input.description && input.description.length > 500) {
    errors.push("description must be at most 500 characters");
  }

  // M5: barcode — optional, trimmed, digits-only convenience (allow common GTIN separators removed), max 64.
  if (input.barcode !== undefined && input.barcode !== null) {
    const barcode = input.barcode.trim();
    if (barcode.length === 0) {
      errors.push("barcode cannot be blank — clear it to remove");
    } else if (barcode.length > 64) {
      errors.push("barcode must be at most 64 characters");
    } else if (!/^[0-9A-Za-z-]+$/.test(barcode)) {
      errors.push("barcode may only contain letters, digits and dashes");
    }
  }

  // M5: unit — optional, trimmed, short.
  if (input.unit !== undefined && input.unit !== null && input.unit.trim().length > 30) {
    errors.push("unit must be at most 30 characters");
  }

  // M5: soldByWeight must be boolean if provided.
  if (input.soldByWeight !== undefined && typeof input.soldByWeight !== "boolean") {
    errors.push("soldByWeight must be a boolean");
  }

  // P3d: featured must be boolean; tags a list of 1..40-char trimmed strings (max 20).
  if (input.featured !== undefined && typeof input.featured !== "boolean") {
    errors.push("featured must be a boolean");
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 20) {
      errors.push("tags must be a list of at most 20 tags");
    } else {
      for (const t of input.tags) {
        if (typeof t !== "string" || t.trim().length < 1 || t.trim().length > 40) {
          errors.push("each tag must be 1-40 characters");
          break;
        }
      }
    }
  }

  // P3d: related/upsell target lists — bounded, well-formed ids.
  for (const [label, ids] of [
    ["relatedProductIds", input.relatedProductIds],
    ["upsellProductIds", input.upsellProductIds],
  ] as const) {
    if (ids !== undefined) {
      if (!Array.isArray(ids) || ids.length > 12) {
        errors.push(`${label} must be a list of at most 12 product ids`);
      } else if (ids.some((x) => typeof x !== "string" || x.length < 8 || x.length > 64)) {
        errors.push(`${label} contains an invalid product id`);
      }
    }
  }

  // P3f: reorder threshold must be a non-negative integer when provided.
  if (input.reorderThreshold !== undefined && (!Number.isInteger(input.reorderThreshold) || input.reorderThreshold < 0)) {
    errors.push("reorderThreshold must be a non-negative integer");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}
