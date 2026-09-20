// Product admin service — tenant-scoped product CRUD + stock.

import { prisma } from "../persistence/prisma-repositories.js";
import { recordMovement } from "../domain/movements.js";
import { validateProductInput, slugify, type ProductInput } from "../domain/product-validation.js";
import type { ApiError } from "@sam-store/contracts";

export type AdminResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export class ProductAdminService {
  /** List products for a store (with stock + category). */
  async list(storeId: string) {
    return this.listFiltered(storeId, {});
  }

  /** List with filters: search (name/SKU), category, price range, active status, featured, tag. */
  async listFiltered(storeId: string, f: { search?: string; categoryId?: string; minPriceMinor?: number; maxPriceMinor?: number; active?: boolean; featured?: boolean; tag?: string }) {
    const where: Record<string, unknown> = { storeId };
    if (f.search) {
      where.OR = [
        { name: { contains: f.search, mode: "insensitive" } },
        { sku: { contains: f.search, mode: "insensitive" } },
        { barcode: { contains: f.search } }, // M5: scan/type a barcode to find the item
      ];
    }
    if (f.categoryId) where.categoryId = f.categoryId;
    if (f.minPriceMinor !== undefined || f.maxPriceMinor !== undefined) {
      where.priceMinor = {};
      if (f.minPriceMinor !== undefined) (where.priceMinor as Record<string, unknown>).gte = f.minPriceMinor;
      if (f.maxPriceMinor !== undefined) (where.priceMinor as Record<string, unknown>).lte = f.maxPriceMinor;
    }
    if (f.active !== undefined) where.isActive = f.active;
    // P3d: merchandising filters.
    if (f.featured !== undefined) where.featured = f.featured;
    if (f.tag) where.tags = { has: f.tag };
    const products = await prisma.product.findMany({
      where,
      orderBy: { createdAt: "asc" },
      include: {
        category: { select: { id: true, name: true, slug: true } },
        stockLevels: { select: { quantityOnHand: true, quantityReserved: true, reorderThreshold: true } },
        variants: { orderBy: { name: "asc" }, select: { id: true, name: true, sku: true, priceMinor: true, quantityOnHand: true, quantityReserved: true, isActive: true } },
        addons: { orderBy: { sortOrder: "asc" }, include: { options: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, priceMinor: true, isActive: true } } } },
        relationsFrom: { orderBy: { sortOrder: "asc" }, select: { kind: true, targetProduct: { select: { id: true, name: true, priceMinor: true, isActive: true } } } },
      },
    });
    return products.map((p) => {
      const onHand = p.stockLevels.reduce((s, l) => s + l.quantityOnHand, 0);
      const reserved = p.stockLevels.reduce((s, l) => s + l.quantityReserved, 0);
      const link = (kind: "related" | "upsell") => p.relationsFrom
        .filter((r) => r.kind === kind)
        .map((r) => ({ id: r.targetProduct.id, name: r.targetProduct.name, priceMinor: r.targetProduct.priceMinor, isActive: r.targetProduct.isActive }));
      return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      barcode: p.barcode,
      unit: p.unit,
      soldByWeight: p.soldByWeight,
      priceMinor: p.priceMinor,
      costMinor: p.costMinor,
      isActive: p.isActive,
      taxExempt: p.taxExempt,
      featured: p.featured,
      tags: p.tags,
      related: link("related"),
      upsell: link("upsell"),
      category: p.category,
      quantityOnHand: onHand,
      quantityReserved: reserved,
      availableQuantity: onHand - reserved,
      reorderThreshold: p.stockLevels[0]?.reorderThreshold ?? 0,
      variants: p.variants.map((v) => ({
        id: v.id,
        name: v.name,
        sku: v.sku,
        priceMinor: v.priceMinor,
        quantityOnHand: v.quantityOnHand,
        quantityReserved: v.quantityReserved,
        availableQuantity: v.quantityOnHand - v.quantityReserved,
        isActive: v.isActive,
      })),
      addons: p.addons.map((a) => ({
        id: a.id,
        name: a.name,
        required: a.required,
        options: a.options.map((o) => ({ id: o.id, name: o.name, priceMinor: o.priceMinor, isActive: o.isActive })),
      })),
    };
    });
  }

  /** Create a product (with optional category by slug + initial stock). */
  async create(storeId: string, input: ProductInput): Promise<AdminResult<{ id: string }>> {
    const validation = validateProductInput(input);
    if (!validation.ok) return { ok: false, error: { type: "validation", errors: validation.errors } };

    const existing = await prisma.product.findUnique({
      where: { storeId_sku: { storeId, sku: input.sku.trim() } },
    });
    if (existing) return { ok: false, error: { type: "conflict", message: "A product with this SKU already exists" } };

    // M5: store-scoped barcode uniqueness (null-safe — multiple products may lack a barcode).
    const barcode = input.barcode?.trim() || null;
    if (barcode) {
      const dup = await prisma.product.findFirst({ where: { storeId, barcode } });
      if (dup) return { ok: false, error: { type: "conflict", message: "A product with this barcode already exists" } };
    }

    let categoryId: string | null = null;
    if (input.categorySlug) {
      const category = await prisma.category.findUnique({
        where: { storeId_slug: { storeId, slug: input.categorySlug } },
      });
      if (!category) return { ok: false, error: { type: "not_found", message: "Category not found" } };
      categoryId = category.id;
    }

    const product = await prisma.product.create({
      data: {
        storeId,
        sku: input.sku.trim(),
        name: input.name.trim(),
        description: input.description?.trim() ?? null,
        barcode,
        unit: input.unit?.trim() || null,
        soldByWeight: input.soldByWeight ?? false,
        priceMinor: input.priceMinor,
        isActive: input.isActive ?? true,
        taxExempt: input.taxExempt ?? false,
        featured: input.featured ?? false,
        tags: (input.tags ?? []).map((t) => t.trim()),
        categoryId,
      },
    });

    // Stock: attach to the store's default warehouse (or a legacy warehouse-less row if none).
    if (input.stock !== undefined) {
      const defaultWarehouse = await prisma.warehouse.findFirst({ where: { storeId, isDefault: true } });
      await prisma.stockLevel.create({
        data: {
          storeId,
          productId: product.id,
          warehouseId: defaultWarehouse?.id ?? null,
          quantityOnHand: input.stock,
        },
      });
    }
    return { ok: true, value: { id: product.id } };
  }

  /** Update a product (price, name, description, stock, category, active). */
  async update(storeId: string, productId: string, input: Partial<ProductInput>): Promise<AdminResult<{ id: string }>> {
    const validation = validateProductInput({
      name: input.name ?? "xx",
      sku: input.sku ?? "xx",
      priceMinor: input.priceMinor ?? 0,
      ...input,
    } as ProductInput);
    if (!validation.ok) return { ok: false, error: { type: "validation", errors: validation.errors } };

    const product = await prisma.product.findFirst({ where: { id: productId, storeId } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };

    // M5: barcode uniqueness on edit — exclude self, allow clearing.
    const barcode = input.barcode !== undefined ? (input.barcode?.trim() || null) : undefined;
    if (barcode) {
      const dup = await prisma.product.findFirst({ where: { storeId, barcode, id: { not: productId } } });
      if (dup) return { ok: false, error: { type: "conflict", message: "A product with this barcode already exists" } };
    }

    // P3d: validate related/upsell targets (same store, active, no self-link) BEFORE mutating.
    const relationInputs = [
      ["related", input.relatedProductIds],
      ["upsell", input.upsellProductIds],
    ] as const;
    for (const [kind, ids] of relationInputs) {
      if (ids === undefined) continue;
      const clean = [...new Set(ids)];
      if (clean.length > 12) return { ok: false, error: { type: "validation", errors: [`${kind}ProductIds cannot exceed 12`] } };
      if (clean.includes(productId)) return { ok: false, error: { type: "validation", errors: [`A product cannot be ${kind === "related" ? "related" : "an upsell"} to itself`] } };
      if (clean.length > 0) {
        const found = await prisma.product.findMany({ where: { storeId, id: { in: clean }, isActive: true }, select: { id: true } });
        const foundIds = new Set(found.map((x) => x.id));
        const missing = clean.filter((id) => !foundIds.has(id));
        if (missing.length > 0) return { ok: false, error: { type: "validation", errors: [`${kind} target not found or inactive`] } };
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: {
          name: input.name?.trim() ?? product.name,
          sku: input.sku?.trim() ?? product.sku,
          description: input.description !== undefined ? input.description?.trim() ?? null : product.description,
          barcode: barcode !== undefined ? barcode : product.barcode,
          unit: input.unit !== undefined ? (input.unit?.trim() || null) : product.unit,
          soldByWeight: input.soldByWeight ?? product.soldByWeight,
          priceMinor: input.priceMinor ?? product.priceMinor,
          isActive: input.isActive ?? product.isActive,
          taxExempt: input.taxExempt ?? product.taxExempt,
          featured: input.featured ?? product.featured,
          tags: input.tags !== undefined ? input.tags.map((t) => t.trim()) : product.tags,
          ...(input.categorySlug !== undefined
            ? { categoryId: input.categorySlug ? (await tx.category.findUnique({ where: { storeId_slug: { storeId, slug: input.categorySlug } } }))?.id ?? null : null }
            : {}),
        },
      });
      // P3d: replace-all related/upsell links when supplied.
      for (const [kind, ids] of relationInputs) {
        if (ids === undefined) continue;
        const clean = [...new Set(ids)];
        await tx.productRelation.deleteMany({ where: { storeId, sourceProductId: productId, kind } });
        if (clean.length > 0) {
          await tx.productRelation.createMany({
            data: clean.map((targetProductId, i) => ({ storeId, sourceProductId: productId, targetProductId, kind, sortOrder: i })),
          });
        }
      }
      if (input.stock !== undefined) {
        // Update stock on the default warehouse (or warehouse-less legacy row) — first match. + ledger (ADJUST)
        const defaultWarehouse = await tx.warehouse.findFirst({ where: { storeId, isDefault: true } });
        const existing = await tx.stockLevel.findFirst({
          where: { storeId, productId, warehouseId: defaultWarehouse?.id ?? null },
        });
        let warehouseId: string | null = null;
        let delta = 0;
        let balanceAfter = 0;
        if (existing) {
          delta = input.stock - existing.quantityOnHand;
          const updated = await tx.stockLevel.update({ where: { id: existing.id }, data: { quantityOnHand: input.stock } });
          warehouseId = updated.warehouseId; balanceAfter = updated.quantityOnHand;
        } else if (defaultWarehouse) {
          const created = await tx.stockLevel.create({ data: { storeId, productId, warehouseId: defaultWarehouse.id, quantityOnHand: input.stock } });
          warehouseId = created.warehouseId; delta = input.stock; balanceAfter = created.quantityOnHand;
        } else {
          const anyRow = await tx.stockLevel.findFirst({ where: { storeId, productId } });
          if (anyRow) {
            delta = input.stock - anyRow.quantityOnHand;
            const updated = await tx.stockLevel.update({ where: { id: anyRow.id }, data: { quantityOnHand: input.stock } });
            warehouseId = updated.warehouseId; balanceAfter = updated.quantityOnHand;
          } else {
            const created = await tx.stockLevel.create({ data: { storeId, productId, quantityOnHand: input.stock } });
            delta = input.stock; balanceAfter = created.quantityOnHand;
          }
        }
        if (delta !== 0) {
          await tx.stockMovement.create({
            data: { storeId, productId, warehouseId, delta, type: "ADJUST", orderId: null, createdBy: null, note: "product edit stock", balanceAfter },
          });
        }
      }
    });
    return { ok: true, value: { id: productId } };
  }

  /** Soft-delete a product (isActive = false). */
  async remove(storeId: string, productId: string): Promise<AdminResult<{ id: string }>> {
    const product = await prisma.product.findFirst({ where: { id: productId, storeId } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    await prisma.product.update({ where: { id: productId }, data: { isActive: false } });
    return { ok: true, value: { id: productId } };
  }

  /** Category helpers (by slug, within store). */
  async listCategories(storeId: string) {
    return prisma.category.findMany({ where: { storeId }, orderBy: { sortOrder: "asc" } });
  }

  async ensureCategory(storeId: string, name: string): Promise<{ id: string }> {
    const slug = slugify(name);
    const category = await prisma.category.upsert({
      where: { storeId_slug: { storeId, slug } },
      update: { name },
      create: { storeId, name, slug },
    });
    return { id: category.id };
  }

  // ─────────────────────────────── Variants (P2c admin) ───────────────────────────────

  /** Create a variant on a store product (own SKU/name/price + opening stock). */
  async addVariant(storeId: string, productId: string, input: { name: string; sku: string; priceMinor: number; quantityOnHand?: number }): Promise<AdminResult<{ id: string }>> {
    const name = input.name?.trim();
    const sku = input.sku?.trim();
    if (!name || name.length > 80) return { ok: false, error: { type: "validation", errors: ["name is required (max 80 chars)"] } };
    if (!sku || sku.length > 64) return { ok: false, error: { type: "validation", errors: ["sku is required (max 64 chars)"] } };
    if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0) return { ok: false, error: { type: "validation", errors: ["priceMinor must be a non-negative integer"] } };
    if (input.quantityOnHand !== undefined && (!Number.isInteger(input.quantityOnHand) || input.quantityOnHand < 0)) return { ok: false, error: { type: "validation", errors: ["quantityOnHand must be a non-negative integer"] } };

    const product = await prisma.product.findFirst({ where: { id: productId, storeId } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    const dup = await prisma.productVariant.findFirst({ where: { storeId, sku } });
    if (dup) return { ok: false, error: { type: "conflict", message: "A variant with this SKU already exists" } };

    const opening = input.quantityOnHand ?? 0;
    const v = await prisma.$transaction(async (tx) => {
      const created = await tx.productVariant.create({
        data: { storeId, productId, name, sku, priceMinor: input.priceMinor, quantityOnHand: opening, quantityReserved: 0 },
      });
      if (opening > 0) {
        await recordMovement(tx, { storeId, productId, variantId: created.id, delta: opening, type: "RECEIPT", createdBy: "admin", balanceAfter: opening });
      }
      return created;
    }, { timeout: 30_000 });
    return { ok: true, value: { id: v.id } };
  }

  /** Update a variant (name/sku/price/active and/or set the on-hand count with an ADJUST ledger row). */
  async updateVariant(storeId: string, variantId: string, input: { name?: string; sku?: string; priceMinor?: number; isActive?: boolean; quantityOnHand?: number }): Promise<AdminResult<{ id: string }>> {
    const v = await prisma.productVariant.findFirst({ where: { id: variantId, storeId } });
    if (!v) return { ok: false, error: { type: "not_found", message: "Variant not found" } };
    if (input.sku !== undefined) {
      const sku = input.sku.trim();
      if (!sku || sku.length > 64) return { ok: false, error: { type: "validation", errors: ["sku is required (max 64 chars)"] } };
      const dup = await prisma.productVariant.findFirst({ where: { storeId, sku, id: { not: variantId } } });
      if (dup) return { ok: false, error: { type: "conflict", message: "A variant with this SKU already exists" } };
    }
    if (input.priceMinor !== undefined && (!Number.isInteger(input.priceMinor) || input.priceMinor < 0)) return { ok: false, error: { type: "validation", errors: ["priceMinor must be a non-negative integer"] } };

    // Stock set: absolute on-hand count with a guarded write + ADJUST movement.
    if (input.quantityOnHand !== undefined) {
      if (!Number.isInteger(input.quantityOnHand) || input.quantityOnHand < 0) return { ok: false, error: { type: "validation", errors: ["quantityOnHand must be a non-negative integer"] } };
      if (input.quantityOnHand < v.quantityReserved) {
        return { ok: false, error: { type: "conflict", message: `Cannot set stock below ${v.quantityReserved} reserved` } };
      }
      const delta = input.quantityOnHand - v.quantityOnHand;
      await prisma.$transaction(async (tx) => {
        await tx.productVariant.update({ where: { id: variantId }, data: { quantityOnHand: input.quantityOnHand } });
        if (delta !== 0) {
          await recordMovement(tx, { storeId, productId: v.productId, variantId: v.id, delta, type: "ADJUST", createdBy: "admin", balanceAfter: input.quantityOnHand });
        }
      }, { timeout: 30_000 });
    }

    await prisma.productVariant.update({
      where: { id: variantId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.sku !== undefined ? { sku: input.sku.trim() } : {}),
        ...(input.priceMinor !== undefined ? { priceMinor: input.priceMinor } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    return { ok: true, value: { id: variantId } };
  }

  /** Delete a variant (refused while stock is reserved by open orders). */
  async deleteVariant(storeId: string, variantId: string): Promise<AdminResult<{ ok: true }>> {
    const v = await prisma.productVariant.findFirst({ where: { id: variantId, storeId } });
    if (!v) return { ok: false, error: { type: "not_found", message: "Variant not found" } };
    if (v.quantityReserved > 0) return { ok: false, error: { type: "conflict", message: "Variant stock is reserved by open orders" } };
    await prisma.productVariant.delete({ where: { id: variantId } });
    return { ok: true, value: { ok: true } };
  }

  // ─────────────────────────────── Add-ons (P2c admin) ───────────────────────────────

  /** Create an add-on group with its options on a store product. */
  async addAddon(storeId: string, productId: string, input: { name: string; required?: boolean; options?: { name: string; priceMinor: number }[] }): Promise<AdminResult<{ id: string }>> {
    const name = input.name?.trim();
    if (!name || name.length > 60) return { ok: false, error: { type: "validation", errors: ["name is required (max 60 chars)"] } };
    const options = (input.options ?? []).map((o) => ({ name: o.name?.trim(), priceMinor: o.priceMinor }));
    if (options.some((o) => !o.name || o.name.length > 60)) return { ok: false, error: { type: "validation", errors: ["option names are required (max 60 chars)"] } };
    if (options.some((o) => !Number.isInteger(o.priceMinor) || o.priceMinor < 0)) return { ok: false, error: { type: "validation", errors: ["option prices must be non-negative integers"] } };

    const product = await prisma.product.findFirst({ where: { id: productId, storeId } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };

    const addon = await prisma.productAddon.create({
      data: {
        storeId, productId, name, required: input.required ?? false, sortOrder: 0,
        options: { create: options.map((o, i) => ({ name: o.name!, priceMinor: o.priceMinor, sortOrder: i })) },
      },
    });
    return { ok: true, value: { id: addon.id } };
  }

  /** Update an add-on option (name/price/active). */
  async updateAddonOption(storeId: string, optionId: string, input: { name?: string; priceMinor?: number; isActive?: boolean }): Promise<AdminResult<{ ok: true }>> {
    const opt = await prisma.productAddonOption.findFirst({ where: { id: optionId, storeId } });
    if (!opt) return { ok: false, error: { type: "not_found", message: "Option not found" } };
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 60)) return { ok: false, error: { type: "validation", errors: ["name is required (max 60 chars)"] } };
    if (input.priceMinor !== undefined && (!Number.isInteger(input.priceMinor) || input.priceMinor < 0)) return { ok: false, error: { type: "validation", errors: ["priceMinor must be a non-negative integer"] } };
    await prisma.productAddonOption.update({
      where: { id: optionId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.priceMinor !== undefined ? { priceMinor: input.priceMinor } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    return { ok: true, value: { ok: true } };
  }

  /** Delete an add-on group (cascades its options). */
  async deleteAddon(storeId: string, addonId: string): Promise<AdminResult<{ ok: true }>> {
    const exist = await prisma.productAddon.findFirst({ where: { id: addonId, storeId } });
    if (!exist) return { ok: false, error: { type: "not_found", message: "Add-on group not found" } };
    await prisma.productAddon.delete({ where: { id: addonId } });
    return { ok: true, value: { ok: true } };
  }

  /** Delete a single add-on option. */
  async deleteAddonOption(storeId: string, optionId: string): Promise<AdminResult<{ ok: true }>> {
    const opt = await prisma.productAddonOption.findFirst({ where: { id: optionId, storeId } });
    if (!opt) return { ok: false, error: { type: "not_found", message: "Option not found" } };
    await prisma.productAddonOption.delete({ where: { id: optionId } });
    return { ok: true, value: { ok: true } };
  }
}