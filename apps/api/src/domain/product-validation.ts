// Product admin validation — pure functions, unit-testable.

export interface ProductInput {
  name: string;
  sku: string;
  priceMinor: number;
  stock?: number;
  categorySlug?: string | null;
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