// Product admin service — tenant-scoped product CRUD + stock.

import { UNLIMITED_STOCK, isTracked, trackOffRefusal } from "../domain/stock-tracking.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { ensureDefaultLocation, recordMovement } from "../domain/movements.js";
import { priceChanges } from "../domain/price-history.js";
import { validateProductInput, slugify, type ProductInput } from "../domain/product-validation.js";
import { newPhotoKey, parsePhoto, isPhotoKey } from "../domain/product-photo.js";
import type { ApiError } from "@sam-store/contracts";
import type { Prisma } from "@prisma/client";
import { isKiloItem, KILO_GROUP_NAME, KILO_GROUP_SLUG, kiloCostFrom, kiloName, kiloPriceFrom, kiloRefusal } from "../domain/kilo.js";
import { varietyOf } from "../domain/resack.js";

/** The store's "1 kg" group (Products → Group) for kilo rice: the owner's own "1kg" / "1 kg" if there is one, else made. */
/** The opening stock named a store that is not this business's (or is turned off). */
class OpeningStoreError extends Error {}

export async function kiloCategoryId(tx: Prisma.TransactionClient, storeId: string): Promise<string> {
  const found = await tx.category.findFirst({ where: { storeId, slug: { in: [KILO_GROUP_SLUG, "1kg"] } }, orderBy: { createdAt: "asc" }, select: { id: true, isActive: true } });
  if (found) {
    if (!found.isActive) await tx.category.update({ where: { id: found.id }, data: { isActive: true } });
    return found.id;
  }
  return (await tx.category.create({ data: { storeId, name: KILO_GROUP_NAME, slug: KILO_GROUP_SLUG }, select: { id: true } })).id;
}

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
        stockLevels: { select: { quantityOnHand: true, quantityReserved: true, reorderThreshold: true, warehouse: { select: { isDefault: true } } } },
        variants: { orderBy: { name: "asc" }, select: { id: true, name: true, sku: true, priceMinor: true, costMinor: true, stockBaseQuantity: true, quantityOnHand: true, quantityReserved: true, isActive: true } },
        addons: { orderBy: { sortOrder: "asc" }, include: { options: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, priceMinor: true, isActive: true } } } },
        relationsFrom: { orderBy: { sortOrder: "asc" }, select: { kind: true, targetProduct: { select: { id: true, name: true, priceMinor: true, isActive: true } } } },
      },
    });
    // "Also sell per kilo": each sack's kilo item (its own line in Products, found even when a filter hides it).
    const kiloItems = await prisma.product.findMany({
      where: { storeId, kiloOfId: { in: products.map((p) => p.id) } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, isActive: true, priceMinor: true, kiloOfId: true },
    });
    const kiloBySack = new Map<string, { id: string; name: string; isActive: boolean; priceMinor: number }>();
    for (const k of kiloItems) if (k.kiloOfId && !kiloBySack.has(k.kiloOfId)) kiloBySack.set(k.kiloOfId, { id: k.id, name: k.name, isActive: k.isActive, priceMinor: k.priceMinor });
    // Display racks: the other sacks that can fill each kilo item.
    const rackRows = await prisma.rackSack.findMany({ where: { storeId, kiloProductId: { in: products.filter((p) => p.soldByWeight).map((p) => p.id) } }, orderBy: { createdAt: "asc" }, select: { kiloProductId: true, sackProductId: true } });
    const rackOf = new Map<string, string[]>();
    for (const r of rackRows) rackOf.set(r.kiloProductId, [...(rackOf.get(r.kiloProductId) ?? []), r.sackProductId]);
    return products.map((p) => {
      const tracked = isTracked(p);
      const onHand = tracked ? p.stockLevels.reduce((s, l) => s + l.quantityOnHand, 0) : UNLIMITED_STOCK;
      const reserved = tracked ? p.stockLevels.reduce((s, l) => s + l.quantityReserved, 0) : 0;
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
      stockBaseUnit: p.stockBaseUnit,
      stockBaseQuantity: p.stockBaseQuantity,
      stockConversionFamily: p.stockConversionFamily,
      priceMinor: p.priceMinor,
      costMinor: p.costMinor,
      trackStock: tracked,
      isActive: p.isActive,
      taxExempt: p.taxExempt,
      featured: p.featured,
      tags: p.tags,
      photoKey: p.photoKey,
      kiloOfId: p.kiloOfId,
      kiloItem: kiloBySack.get(p.id) ?? null,
      rackSackIds: rackOf.get(p.id) ?? [],
      related: link("related"),
      upsell: link("upsell"),
      category: p.category,
      quantityOnHand: onHand,
      quantityReserved: reserved,
      availableQuantity: onHand - reserved,
      // The main store's row: the one update() writes (any row used to be read, so a save copied it over).
      // The main store's row: the one update() writes. (Each store's own level is on Inventory.)
      reorderThreshold: p.stockLevels.find((l) => l.warehouse?.isDefault)?.reorderThreshold ?? 0,
      variants: p.variants.map((v) => ({
        id: v.id,
        name: v.name,
        sku: v.sku,
        priceMinor: v.priceMinor,
        costMinor: v.costMinor,
        stockBaseQuantity: v.stockBaseQuantity,
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

  /** Create a product (optional existing/new category, unit cost, and opening stock). */
  async create(storeId: string, input: ProductInput, actorId?: string): Promise<AdminResult<{ id: string }>> {
    const validation = validateProductInput(input);
    if (!validation.ok) return { ok: false, error: { type: "validation", errors: validation.errors } };

    const existing = await prisma.product.findUnique({
      where: { storeId_sku: { storeId, sku: input.sku.trim() } },
    });
    if (existing) return { ok: false, error: { type: "conflict", message: "A product with this SKU already exists" } };

    if (input.trackStock === false) {
      const refusal = trackOffRefusal(input);
      if (refusal) return { ok: false, error: { type: "validation", errors: [refusal] } };
    }

    // M5: store-scoped barcode uniqueness (null-safe — multiple products may lack a barcode).
    const barcode = input.barcode?.trim() || null;
    if (barcode) {
      const dup = await prisma.product.findFirst({ where: { storeId, barcode } });
      if (dup) return { ok: false, error: { type: "conflict", message: "A product with this barcode already exists" } };
    }

    try {
    return await prisma.$transaction(async (tx): Promise<AdminResult<{ id: string }>> => {
      let categoryId: string | null = null;
      if (input.categorySlug) {
        const category = await tx.category.findUnique({
          where: { storeId_slug: { storeId, slug: input.categorySlug.trim() } },
        });
        if (!category) return { ok: false, error: { type: "not_found", message: "Category not found" } };
        categoryId = category.id;
      } else if (input.categoryName?.trim()) {
        const name = input.categoryName.trim();
        const slug = slugify(name);
        const existing = await tx.category.findUnique({ where: { storeId_slug: { storeId, slug } } });
        if (existing) {
          return { ok: false, error: { type: "conflict", message: "That category already exists — choose it from the category list" } };
        }
        const category = await tx.category.create({ data: { storeId, name, slug } });
        categoryId = category.id;
      }

      const product = await tx.product.create({
        data: {
          storeId,
          sku: input.sku.trim(),
          name: input.name.trim(),
          description: input.description?.trim() ?? null,
          barcode,
          unit: input.unit?.trim() || null,
        soldByWeight: input.soldByWeight ?? false,
          stockBaseUnit: input.stockBaseUnit?.trim() || null,
          stockBaseQuantity: input.stockBaseQuantity ?? null,
          stockConversionFamily: input.stockConversionFamily?.trim().toLowerCase() || null,
          priceMinor: input.priceMinor,
          costMinor: input.costMinor ?? 0,
          trackStock: input.trackStock ?? true,
          isActive: input.isActive ?? true,
          taxExempt: input.taxExempt ?? false,
          featured: input.featured ?? false,
          tags: (input.tags ?? []).map((t) => t.trim()),
          categoryId,
        },
      });

      // Opening stock and its ledger receipt are committed with the product/category.
      // 2026-11-21: it goes to the store the form names (stockLocationId), else the main store; the reorder
      // level is the main store's, like on the edit form. Each is its own store's row, never "the first row".
      if ((input.stock !== undefined || input.reorderThreshold !== undefined) && input.trackStock !== false) {
        const mainId = await ensureDefaultLocation(tx, storeId);
        const openingStock = input.stock ?? 0;
        let stockAt = mainId;
        if (openingStock > 0 && input.stockLocationId && input.stockLocationId !== mainId) {
          const place = await tx.warehouse.findFirst({ where: { id: input.stockLocationId, storeId, isActive: true }, select: { id: true } });
          if (!place) throw new OpeningStoreError();
          stockAt = place.id;
        }
        if (openingStock > 0) {
          await tx.stockLevel.create({ data: { storeId, productId: product.id, warehouseId: stockAt, quantityOnHand: openingStock } });
          await recordMovement(tx, {
            storeId,
            productId: product.id,
            warehouseId: stockAt,
            delta: openingStock,
            type: "RECEIPT",
            createdBy: actorId ?? null,
            note: "Opening stock at product creation",
            balanceAfter: openingStock,
          });
        }
        if (input.reorderThreshold !== undefined || openingStock === 0) {
          await tx.stockLevel.upsert({
            where: { storeId_productId_warehouseId: { storeId, productId: product.id, warehouseId: mainId } },
            create: { storeId, productId: product.id, warehouseId: mainId, quantityOnHand: 0, reorderThreshold: input.reorderThreshold ?? 0 },
            update: { reorderThreshold: input.reorderThreshold ?? 0 },
          });
        }
      }

      return { ok: true, value: { id: product.id } };
    }, { timeout: 30_000 });
    } catch (e) {
      if (e instanceof OpeningStoreError) return { ok: false, error: { type: "validation", errors: ["Choose a store for the opening stock"] } };
      throw e;
    }
  }

  /** Update a product (price, name, description, stock, category, active). */
  async update(storeId: string, productId: string, input: Partial<ProductInput>, actorId?: string): Promise<AdminResult<{ id: string }>> {
    const product = await prisma.product.findFirst({ where: { id: productId, storeId } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };

    const validation = validateProductInput({
      name: input.name ?? "xx",
      sku: input.sku ?? "xx",
      priceMinor: input.priceMinor ?? 0,
      stockBaseUnit: input.stockBaseUnit !== undefined ? input.stockBaseUnit : product.stockBaseUnit,
      stockBaseQuantity: input.stockBaseQuantity !== undefined ? input.stockBaseQuantity : product.stockBaseQuantity,
      stockConversionFamily: input.stockConversionFamily !== undefined ? input.stockConversionFamily : product.stockConversionFamily,
      ...input,
    } as ProductInput);
    if (!validation.ok) return { ok: false, error: { type: "validation", errors: validation.errors } };

    const nextStockBaseUnit = input.stockBaseUnit !== undefined ? (input.stockBaseUnit?.trim() || null) : product.stockBaseUnit;
    const nextStockBaseQuantity = input.stockBaseQuantity !== undefined ? input.stockBaseQuantity : product.stockBaseQuantity;
    // 2026-11-21: the rice import saved the family as "Bigas" while the form sends "bigas". Compare without
    // case, and keep the saved spelling when only the case differs, or every edit of a rice with stock (even
    // just its name) was refused as "changing the stock measure".
    const familyKey = (f: string | null | undefined) => f?.trim().toLowerCase() || null;
    const nextConversionFamily = input.stockConversionFamily !== undefined && familyKey(input.stockConversionFamily) !== familyKey(product.stockConversionFamily)
      ? familyKey(input.stockConversionFamily)
      : product.stockConversionFamily;
    if (product.stockBaseUnit && (nextStockBaseUnit !== product.stockBaseUnit || nextStockBaseQuantity !== product.stockBaseQuantity || nextConversionFamily !== product.stockConversionFamily)) {
      const [levels, variants] = await Promise.all([
        prisma.stockLevel.findMany({ where: { storeId, productId }, select: { quantityOnHand: true, quantityReserved: true } }),
        prisma.productVariant.findMany({ where: { storeId, productId }, select: { quantityOnHand: true, quantityReserved: true } }),
      ]);
      const hasStock = [...levels, ...variants].some((row) => row.quantityOnHand > 0 || row.quantityReserved > 0);
      if (hasStock) return { ok: false, error: { type: "conflict", message: "Cannot change a configured stock measure while inventory or reservations exist" } };
    }

    const nextTrack = input.trackStock ?? isTracked(product);
    if (!nextTrack) {
      const refusal = trackOffRefusal({ stockBaseUnit: nextStockBaseUnit, stockBaseQuantity: nextStockBaseQuantity, stockConversionFamily: nextConversionFamily });
      if (refusal) return { ok: false, error: { type: "validation", errors: [refusal] } };
    }

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
      const changes = priceChanges(product, { costMinor: input.costMinor, priceMinor: input.priceMinor });
      if (changes.length > 0) {
        await tx.priceHistory.createMany({
          data: changes.map((c) => ({ storeId, productId, field: c.field, oldMinor: c.oldMinor, newMinor: c.newMinor, source: "MANUAL", changedById: actorId ?? null })),
        });
      }
      await tx.product.update({
        where: { id: productId },
        data: {
          name: input.name?.trim() ?? product.name,
          sku: input.sku?.trim() ?? product.sku,
          description: input.description !== undefined ? input.description?.trim() ?? null : product.description,
          barcode: barcode !== undefined ? barcode : product.barcode,
          unit: input.unit !== undefined ? (input.unit?.trim() || null) : product.unit,
          soldByWeight: input.soldByWeight ?? product.soldByWeight,
          stockBaseUnit: input.stockBaseUnit !== undefined ? (input.stockBaseUnit?.trim() || null) : product.stockBaseUnit,
          stockBaseQuantity: input.stockBaseQuantity !== undefined ? input.stockBaseQuantity : product.stockBaseQuantity,
          stockConversionFamily: nextConversionFamily,
          priceMinor: input.priceMinor ?? product.priceMinor,
          costMinor: input.costMinor ?? product.costMinor,
          trackStock: nextTrack,
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
      // 2026-11-21: an edit never sets stock. The form used to send the total of ALL stores, which was
      // written to the main store (rename a rice with 10 at each of 4 places → main store 40).
      // Stock changes go through Stock in, Move stock, Count or Inventory → Adjust.
      // (input.stock is ignored here on purpose.)
      if (input.reorderThreshold !== undefined) {
        // The main store's reorder level (each store sets its own in Inventory → Adjust).
        const mainId = await ensureDefaultLocation(tx, storeId);
        await tx.stockLevel.upsert({
          where: { storeId_productId_warehouseId: { storeId, productId, warehouseId: mainId } },
          create: { storeId, productId, warehouseId: mainId, quantityOnHand: 0, reorderThreshold: input.reorderThreshold },
          update: { reorderThreshold: input.reorderThreshold },
        });
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

  /**
   * "Also sell per kilo" on a sack rice (2026-11-20). On: make (or bring back) its kilo item,
   * "Sinandomeng · per kilo", stocked in grams, priced per kilo at every store from that store's
   * sack price (÷ kilos, rounded up, + ₱2). Off: hide the kilo item; kilos left stay in stock.
   * Only stores with "Sell per kilo here" on show it on POS / Pre-order.
   */
  async setKiloItem(storeId: string, sackId: string, on: boolean, force = false): Promise<AdminResult<{ sackId: string; kiloItem: { id: string; name: string; isActive: boolean; priceMinor: number } | null }>> {
    const sack = await prisma.product.findFirst({
      where: { id: sackId, storeId },
      select: { id: true, sku: true, name: true, variety: true, soldByWeight: true, stockBaseUnit: true, stockBaseQuantity: true, stockConversionFamily: true, priceMinor: true, costMinor: true, categoryId: true, photoKey: true, isActive: true, kiloOfId: true },
    });
    if (!sack) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    const existing = await prisma.product.findFirst({ where: { storeId, kiloOfId: sack.id }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, isActive: true, priceMinor: true } });
    if (!on) {
      // Kilos still on the rack would be stuck (hidden from POS and count): say so first.
      if (existing?.isActive && !force) {
        const left = await prisma.stockLevel.aggregate({ where: { storeId, productId: existing.id }, _sum: { quantityOnHand: true } });
        const grams = left._sum.quantityOnHand ?? 0;
        if (grams > 0) return { ok: false, error: { type: "conflict", message: `${existing.name} still has ${Math.round(grams / 100) / 10} kg. Sell or count them first, or hide it anyway.` } };
      }
      if (existing?.isActive) await prisma.product.update({ where: { id: existing.id }, data: { isActive: false } });
      return { ok: true, value: { sackId: sack.id, kiloItem: existing ? { ...existing, isActive: false } : null } };
    }
    const refusal = kiloRefusal(sack);
    if (refusal) return { ok: false, error: { type: "validation", errors: [refusal] } };
    if (existing) {
      if (!existing.isActive) await prisma.product.update({ where: { id: existing.id }, data: { isActive: true } });
      return { ok: true, value: { sackId: sack.id, kiloItem: { ...existing, isActive: true } } };
    }
    const grams = sack.stockBaseQuantity!;
    // A free SKU: SACK-KILO, then SACK-KILO-2, …
    const taken = new Set((await prisma.product.findMany({ where: { storeId, sku: { startsWith: `${sack.sku}-KILO` } }, select: { sku: true } })).map((r) => r.sku));
    let sku = `${sack.sku}-KILO`;
    for (let i = 2; taken.has(sku); i++) sku = `${sack.sku}-KILO-${i}`;
    const sackPrices = await prisma.locationPrice.findMany({ where: { storeId, productId: sack.id }, select: { warehouseId: true, priceMinor: true } });
    const item = await prisma.$transaction(async (tx) => {
      // Every kilo item goes in the "1 kg" group, so they show together on POS (like the 5kg group).
      const kiloGroup = await kiloCategoryId(tx, storeId);
      const p = await tx.product.create({
        data: {
          storeId, sku, name: kiloName(sack.name), variety: varietyOf(sack), unit: "kilo", soldByWeight: true,
          stockBaseUnit: "g", stockBaseQuantity: 1, stockConversionFamily: sack.stockConversionFamily,
          priceMinor: kiloPriceFrom(sack.priceMinor, grams), costMinor: kiloCostFrom(sack.costMinor, grams),
          trackStock: true, isActive: true, categoryId: kiloGroup, photoKey: sack.photoKey, kiloOfId: sack.id,
        },
        select: { id: true, name: true, isActive: true, priceMinor: true },
      });
      // Each store's own sack price gives that store's own kilo price.
      if (sackPrices.length) {
        await tx.locationPrice.createMany({ data: sackPrices.map((lp) => ({ storeId, productId: p.id, warehouseId: lp.warehouseId, priceMinor: kiloPriceFrom(lp.priceMinor, grams) })) });
      }
      return p;
    });
    return { ok: true, value: { sackId: sack.id, kiloItem: item } };
  }

  /**
   * Display rack: which sacks can fill this kilo item (besides its own sack). Replaces the list.
   * Any loose rice can be a rack, also one made by hand earlier (this links it to its sacks).
   */
  async setRackSacks(storeId: string, kiloId: string, sackIds: unknown): Promise<AdminResult<{ id: string; rackSackIds: string[] }>> {
    if (!Array.isArray(sackIds) || sackIds.some((x) => typeof x !== "string")) return { ok: false, error: { type: "validation", errors: ["Choose the sacks"] } };
    const kilo = await prisma.product.findFirst({ where: { id: kiloId, storeId }, select: { id: true, name: true, soldByWeight: true, stockBaseUnit: true, stockBaseQuantity: true, kiloOfId: true } });
    if (!kilo) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    if (!isKiloItem(kilo)) return { ok: false, error: { type: "validation", errors: [`${kilo.name} is not sold per kilo`] } };
    const ids = [...new Set(sackIds as string[])].filter((id) => id !== kilo.kiloOfId);
    const sacks = await prisma.product.findMany({ where: { storeId, id: { in: ids } }, select: { id: true, name: true, soldByWeight: true, stockBaseUnit: true, stockBaseQuantity: true } });
    if (sacks.length !== ids.length) return { ok: false, error: { type: "validation", errors: ["One of the sacks was not found"] } };
    for (const sk of sacks) {
      const why = kiloRefusal(sk);
      if (why) return { ok: false, error: { type: "validation", errors: [why] } };
    }
    await prisma.$transaction([
      prisma.rackSack.deleteMany({ where: { storeId, kiloProductId: kilo.id, sackProductId: { notIn: ids } } }),
      ...ids.map((sackProductId) => prisma.rackSack.upsert({
        where: { storeId_kiloProductId_sackProductId: { storeId, kiloProductId: kilo.id, sackProductId } },
        create: { storeId, kiloProductId: kilo.id, sackProductId }, update: {},
      })),
    ]);
    return { ok: true, value: { id: kilo.id, rackSackIds: ids } };
  }

  /**
   * Put a picture on a product (replaces the old one). `dataUrl` is the shrunk picture from the tablet.
   * A new key each time, so the tablet's saved copy of the old address is never shown for the new picture.
   */
  async setPhoto(storeId: string, productId: string, dataUrl: unknown): Promise<AdminResult<{ id: string; photoKey: string }>> {
    const photo = parsePhoto(dataUrl);
    if (!photo.ok) return { ok: false, error: { type: "validation", errors: [photo.error] } };
    const product = await prisma.product.findFirst({ where: { id: productId, storeId }, select: { id: true } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    const key = newPhotoKey();
    await prisma.$transaction([
      prisma.productPhoto.deleteMany({ where: { storeId, productId } }),
      prisma.productPhoto.create({ data: { id: key, storeId, productId, mime: photo.mime, data: photo.data } }),
      prisma.product.update({ where: { id: productId }, data: { photoKey: key } }),
    ]);
    return { ok: true, value: { id: productId, photoKey: key } };
  }

  /** Take the picture off a product: its tiles go back to the plain button. */
  async removePhoto(storeId: string, productId: string): Promise<AdminResult<{ id: string }>> {
    const product = await prisma.product.findFirst({ where: { id: productId, storeId }, select: { id: true } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    await prisma.$transaction([
      prisma.productPhoto.deleteMany({ where: { storeId, productId } }),
      prisma.product.update({ where: { id: productId }, data: { photoKey: null } }),
    ]);
    return { ok: true, value: { id: productId } };
  }

  /** The picture behind a key (public: the key is random and only reaches people who see the product). */
  async photo(key: string): Promise<{ mime: string; data: Buffer } | null> {
    if (!isPhotoKey(key)) return null;
    const p = await prisma.productPhoto.findUnique({ where: { id: key }, select: { mime: true, data: true } });
    return p ? { mime: p.mime, data: Buffer.from(p.data) } : null;
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
  async addVariant(storeId: string, productId: string, input: { name: string; sku: string; priceMinor: number; costMinor?: number; stockBaseQuantity?: number; quantityOnHand?: number }, actorId?: string): Promise<AdminResult<{ id: string }>> {
    const name = input.name?.trim();
    const sku = input.sku?.trim();
    if (!name || name.length > 80) return { ok: false, error: { type: "validation", errors: ["name is required (max 80 chars)"] } };
    if (!sku || sku.length > 64) return { ok: false, error: { type: "validation", errors: ["sku is required (max 64 chars)"] } };
    if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0) return { ok: false, error: { type: "validation", errors: ["priceMinor must be a non-negative integer"] } };
    if (input.costMinor !== undefined && (!Number.isInteger(input.costMinor) || input.costMinor < 0)) return { ok: false, error: { type: "validation", errors: ["costMinor must be a non-negative integer"] } };
    if (input.stockBaseQuantity !== undefined && (!Number.isInteger(input.stockBaseQuantity) || input.stockBaseQuantity < 1)) return { ok: false, error: { type: "validation", errors: ["stockBaseQuantity must be a positive integer"] } };
    if (input.quantityOnHand !== undefined && (!Number.isInteger(input.quantityOnHand) || input.quantityOnHand < 0)) return { ok: false, error: { type: "validation", errors: ["quantityOnHand must be a non-negative integer"] } };

    const product = await prisma.product.findFirst({ where: { id: productId, storeId }, select: { id: true, stockBaseUnit: true } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    if (input.stockBaseQuantity !== undefined && !product.stockBaseUnit) return { ok: false, error: { type: "validation", errors: ["set the product stock base unit before configuring a variant size"] } };
    const dup = await prisma.productVariant.findFirst({ where: { storeId, sku } });
    if (dup) return { ok: false, error: { type: "conflict", message: "A variant with this SKU already exists" } };

    const opening = input.quantityOnHand ?? 0;
    const v = await prisma.$transaction(async (tx) => {
      const created = await tx.productVariant.create({
        data: {
          storeId, productId, name, sku, priceMinor: input.priceMinor,
          costMinor: input.costMinor ?? 0,
          stockBaseQuantity: input.stockBaseQuantity ?? null,
          quantityOnHand: opening, quantityReserved: 0,
        },
      });
      if (opening > 0) {
        await recordMovement(tx, { storeId, productId, variantId: created.id, delta: opening, type: "RECEIPT", createdBy: actorId ?? null, note: "Opening variant stock", balanceAfter: opening });
      }
      return created;
    }, { timeout: 30_000 });
    return { ok: true, value: { id: v.id } };
  }

  /** Update a variant (name/sku/price/active and/or set the on-hand count with an ADJUST ledger row). */
  async updateVariant(storeId: string, variantId: string, input: { name?: string; sku?: string; priceMinor?: number; costMinor?: number; stockBaseQuantity?: number | null; isActive?: boolean; quantityOnHand?: number }): Promise<AdminResult<{ id: string }>> {
    const v = await prisma.productVariant.findFirst({ where: { id: variantId, storeId } });
    if (!v) return { ok: false, error: { type: "not_found", message: "Variant not found" } };
    if (input.sku !== undefined) {
      const sku = input.sku.trim();
      if (!sku || sku.length > 64) return { ok: false, error: { type: "validation", errors: ["sku is required (max 64 chars)"] } };
      const dup = await prisma.productVariant.findFirst({ where: { storeId, sku, id: { not: variantId } } });
      if (dup) return { ok: false, error: { type: "conflict", message: "A variant with this SKU already exists" } };
    }
    if (input.priceMinor !== undefined && (!Number.isInteger(input.priceMinor) || input.priceMinor < 0)) return { ok: false, error: { type: "validation", errors: ["priceMinor must be a non-negative integer"] } };
    if (input.costMinor !== undefined && (!Number.isInteger(input.costMinor) || input.costMinor < 0)) return { ok: false, error: { type: "validation", errors: ["costMinor must be a non-negative integer"] } };
    if (input.stockBaseQuantity !== undefined && input.stockBaseQuantity !== null && (!Number.isInteger(input.stockBaseQuantity) || input.stockBaseQuantity < 1)) return { ok: false, error: { type: "validation", errors: ["stockBaseQuantity must be a positive integer"] } };
    if (input.stockBaseQuantity !== undefined && input.stockBaseQuantity !== null) {
      const product = await prisma.product.findFirst({ where: { id: v.productId, storeId }, select: { stockBaseUnit: true } });
      if (!product?.stockBaseUnit) return { ok: false, error: { type: "validation", errors: ["set the product stock base unit before configuring a variant size"] } };
    }
    if (input.stockBaseQuantity !== undefined && input.stockBaseQuantity !== v.stockBaseQuantity && v.stockBaseQuantity !== null
      && (v.quantityOnHand > 0 || v.quantityReserved > 0)) {
      return { ok: false, error: { type: "conflict", message: "Cannot change a configured variant pack size while stock or reservations exist" } };
    }

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
        ...(input.costMinor !== undefined ? { costMinor: input.costMinor } : {}),
        ...(input.stockBaseQuantity !== undefined ? { stockBaseQuantity: input.stockBaseQuantity } : {}),
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

  /** P3e: update an add-on group (name / required flag). */
  async updateAddon(storeId: string, addonId: string, input: { name?: string; required?: boolean }): Promise<AdminResult<{ ok: true }>> {
    const group = await prisma.productAddon.findFirst({ where: { id: addonId, storeId } });
    if (!group) return { ok: false, error: { type: "not_found", message: "Add-on group not found" } };
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 60)) return { ok: false, error: { type: "validation", errors: ["name is required (max 60 chars)"] } };
    if (input.required !== undefined && typeof input.required !== "boolean") return { ok: false, error: { type: "validation", errors: ["required must be a boolean"] } };
    await prisma.productAddon.update({
      where: { id: addonId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.required !== undefined ? { required: input.required } : {}),
      },
    });
    return { ok: true, value: { ok: true } };
  }

  /** P3e: add an option to an existing add-on group (appended in sort order). */
  async addAddonOption(storeId: string, addonId: string, input: { name: string; priceMinor: number }): Promise<AdminResult<{ id: string }>> {
    const group = await prisma.productAddon.findFirst({ where: { id: addonId, storeId } });
    if (!group) return { ok: false, error: { type: "not_found", message: "Add-on group not found" } };
    const name = input.name?.trim();
    if (!name || name.length > 60) return { ok: false, error: { type: "validation", errors: ["name is required (max 60 chars)"] } };
    if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0) return { ok: false, error: { type: "validation", errors: ["priceMinor must be a non-negative integer"] } };
    const last = await prisma.productAddonOption.findFirst({ where: { storeId, addonId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    const option = await prisma.productAddonOption.create({
      data: { storeId, addonId, name, priceMinor: input.priceMinor, sortOrder: (last?.sortOrder ?? -1) + 1 },
    });
    return { ok: true, value: { id: option.id } };
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

  /** Newest first. Each line: what changed, old and new value, who, when, and where it came from. */
  async priceHistory(storeId: string, productId: string): Promise<AdminResult<{ rows: { id: string; field: string; oldMinor: number; newMinor: number; source: string; reason: string | null; who: string | null; at: string }[] }>> {
    const product = await prisma.product.findFirst({ where: { id: productId, storeId }, select: { id: true } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    const rows = await prisma.priceHistory.findMany({ where: { storeId, productId }, orderBy: { createdAt: "desc" }, take: 200 });
    const ids = [...new Set(rows.map((r) => r.changedById).filter((x): x is string => !!x))];
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name || u.email || "Staff"]));
    return {
      ok: true,
      value: {
        rows: rows.map((r) => ({ id: r.id, field: r.field, oldMinor: r.oldMinor, newMinor: r.newMinor, source: r.source, reason: r.reason, who: r.changedById ? nameOf.get(r.changedById) ?? "Staff" : null, at: r.createdAt.toISOString() })),
      },
    };
  }
}
