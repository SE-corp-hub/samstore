// Inventory: aggregated per product across warehouses, with filters + value at cost.
// Filters: search (name/SKU), category, warehouse, stock status (in/low/out).
// Inventory value = Σ costMinor × quantityOnHand (cost from latest purchase).
//
// M2 adds the operator-facing ledger screens: a reasoned, actor-attributed adjustment
// (the ONE writer besides POS/checkout paths) and the history/flow reads over
// StockMovement. Balances stay derived — the movement row is the source of truth.

import { prisma } from "../persistence/prisma-repositories.js";
import { adjustStock, InsufficientStockError, recordMovement } from "../domain/movements.js";
import { planStockConversion } from "../domain/stock-conversion.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import type { ApiError } from "@sam-store/contracts";

export const INVENTORY_SERVICE = Symbol("INVENTORY_SERVICE");

export type InventoryResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface InventoryConversionInput {
  idempotencyKey: string;
  sourceProductId: string;
  sourceVariantId?: string;
  destinationProductId: string;
  destinationVariantId?: string;
  warehouseId?: string;
  sourceQuantity: number;
  outputQuantity: number;
  reason: string;
  wasteReason?: string;
}

class StockConversionConflictError extends Error {}

function weightedUnitCost(existingQuantity: number, existingCostMinor: number, incomingQuantity: number, incomingValueMinor: number): number {
  const quantity = BigInt(existingQuantity + incomingQuantity);
  if (quantity <= 0n) return 0;
  const value = BigInt(existingQuantity) * BigInt(existingCostMinor) + BigInt(incomingValueMinor);
  return Number((value + quantity / 2n) / quantity);
}

export class InventoryService {
  async list(storeId: string, filters: { search?: string; categoryId?: string; warehouseId?: string; status?: "in" | "low" | "out" } = {}) {
    const where: Record<string, unknown> = { storeId, isActive: true };
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: "insensitive" } },
        { sku: { contains: filters.search, mode: "insensitive" } },
      ];
    }
    if (filters.categoryId) where.categoryId = filters.categoryId;

    const products = await prisma.product.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
        stockLevels: true,
        variants: { orderBy: { name: "asc" }, select: { id: true, name: true, sku: true, costMinor: true, stockBaseQuantity: true, quantityOnHand: true, quantityReserved: true, isActive: true } },
      },
      orderBy: { name: "asc" },
    });

    const rows = products.map((p) => {
      const levels = filters.warehouseId ? p.stockLevels.filter((l) => l.warehouseId === filters.warehouseId) : p.stockLevels;
      const onHand = levels.reduce((s, l) => s + l.quantityOnHand, 0);
      const reserved = levels.reduce((s, l) => s + l.quantityReserved, 0);
      const threshold = Math.max(0, ...levels.map((l) => l.reorderThreshold));
      const available = onHand - reserved;
      let status: "in" | "low" | "out" | "untracked";
      if (p.trackStock === false) status = "untracked"; // sells at any time — never out or low
      else if (available <= 0 && onHand <= 0) status = "out";
      else if (threshold > 0 && available <= threshold) status = "low";
      else status = "in";
      const valueMinor = p.trackStock === false ? 0 : onHand * p.costMinor;
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category?.name ?? null,
        quantityOnHand: onHand,
        quantityReserved: reserved,
         availableQuantity: available,
         reorderThreshold: threshold,
         costMinor: p.costMinor,
         trackStock: p.trackStock !== false,
         stockBaseUnit: p.stockBaseUnit,
         stockBaseQuantity: p.stockBaseQuantity,
         stockConversionFamily: p.stockConversionFamily,
         stockLevels: p.stockLevels.map((level) => ({
           warehouseId: level.warehouseId,
           quantityOnHand: level.quantityOnHand,
           quantityReserved: level.quantityReserved,
         })),
         variants: p.variants.map((variant) => ({
           id: variant.id,
           name: variant.name,
           sku: variant.sku,
           costMinor: variant.costMinor,
           stockBaseQuantity: variant.stockBaseQuantity,
           quantityOnHand: variant.quantityOnHand,
           quantityReserved: variant.quantityReserved,
           availableQuantity: variant.quantityOnHand - variant.quantityReserved,
           isActive: variant.isActive,
         })),
         valueMinor,
        status,
      };
    });

    const filtered = filters.status ? rows.filter((r) => r.status === filters.status) : rows;
    const totalValueMinor = filtered.reduce((s, r) => s + r.valueMinor, 0);
    return { items: filtered, totalValueMinor, count: filtered.length };
  }

  /**
   * M2: apply a stock adjustment (+delta / −delta / counted setTo) with a required reason.
   * Manager-gated at the controller; the ledger row carries the actor and the reason.
   */
  async adjust(
    storeId: string,
    actorId: string,
    input: { productId: string; warehouseId?: string | null; delta?: number; setTo?: number; reason?: string; allowNegative?: boolean },
  ): Promise<InventoryResult<{ productId: string; balanceAfter: number; delta: number }>> {
    const reason = (input.reason ?? "").trim();
    if (reason.length < 3 || reason.length > 200) {
      return { ok: false, error: { type: "validation", errors: ["reason is required (3-200 chars) — it is stored on the movement"] } };
    }
    if ((input.delta === undefined) === (input.setTo === undefined)) {
      return { ok: false, error: { type: "validation", errors: ["provide either delta (+/−) or setTo (counted quantity)"] } };
    }
    const product = await prisma.product.findFirst({ where: { id: input.productId, storeId }, select: { id: true } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    if (input.warehouseId) {
      const wh = await prisma.warehouse.findFirst({ where: { id: input.warehouseId, storeId }, select: { id: true } });
      if (!wh) return { ok: false, error: { type: "not_found", message: "Warehouse not found" } };
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const out = await adjustStock(tx, {
          storeId,
          productId: input.productId,
          warehouseId: input.warehouseId ?? null,
          delta: input.delta,
          setTo: input.setTo,
          reason,
          actorId,
          allowNegative: input.allowNegative === true,
        });
        await tx.auditLog.create({
          data: {
            storeId,
            actorType: "USER",
            actorId,
            action: "stock.adjust",
            entityType: "Product",
            entityId: input.productId,
            after: { delta: out.delta, balanceAfter: out.balanceAfter, reason, allowNegative: input.allowNegative === true } as object,
          },
        });
        return out;
      }, { timeout: 30_000 });
      // M4 fix: the admin products list is cached for 30 s, so without this bust the operator
      // would adjust stock and keep reading the OLD on-hand for half a minute (the storefront
      // reads live, which is exactly why the mismatch looked like a storefront bug).
      await cacheBust(cacheKey("products", storeId));
      await cacheBust(cacheKey("inventory", storeId));
      return { ok: true, value: { productId: input.productId, balanceAfter: result.balanceAfter, delta: result.delta } };
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        return { ok: false, error: { type: "conflict", message: `Not enough stock — short by ${e.shortfall} unit(s). Tick "allow negative" for a stock-take correction.` } };
      }
      const msg = e instanceof Error ? e.message : "Adjustment failed";
      return { ok: false, error: { type: "conflict", message: msg } };
    }
  }

  /** Convert tracked stock between sellable products/variants in one audited transaction. */
  async convert(
    storeId: string,
    actorId: string,
    input: InventoryConversionInput,
  ): Promise<InventoryResult<{ conversionId: string; sourceBalanceAfter: number; outputBalanceAfter: number; wasteBaseQuantity: number }>> {
    const idempotencyKey = (input.idempotencyKey ?? "").trim();
    const reason = (input.reason ?? "").trim();
    const wasteReason = (input.wasteReason ?? "").trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      return { ok: false, error: { type: "validation", errors: ["idempotencyKey must be 8-200 characters"] } };
    }
    if (reason.length < 3 || reason.length > 200) {
      return { ok: false, error: { type: "validation", errors: ["reason is required (3-200 chars)"] } };
    }
    if (wasteReason.length > 200) {
      return { ok: false, error: { type: "validation", errors: ["wasteReason must be at most 200 characters"] } };
    }
    if (!Number.isInteger(input.sourceQuantity) || input.sourceQuantity < 1 || input.sourceQuantity > 1_000_000) {
      return { ok: false, error: { type: "validation", errors: ["sourceQuantity must be a positive integer"] } };
    }
    if (!Number.isInteger(input.outputQuantity) || input.outputQuantity < 1 || input.outputQuantity > 1_000_000) {
      return { ok: false, error: { type: "validation", errors: ["outputQuantity must be a positive integer"] } };
    }
    if (input.sourceProductId === input.destinationProductId && (input.sourceVariantId ?? null) === (input.destinationVariantId ?? null)) {
      return { ok: false, error: { type: "validation", errors: ["source and destination must be different stock items"] } };
    }

    const existing = await prisma.stockConversion.findUnique({ where: { idempotencyKey } });
    if (existing) {
      const sameRequest = existing.storeId === storeId
        && existing.sourceProductId === input.sourceProductId
        && existing.sourceVariantId === (input.sourceVariantId ?? null)
        && existing.destinationProductId === input.destinationProductId
        && existing.destinationVariantId === (input.destinationVariantId ?? null)
        && existing.sourceQuantity === input.sourceQuantity
        && existing.outputQuantity === input.outputQuantity
        && existing.reason === reason
        && (!input.warehouseId?.trim() || (input.sourceVariantId && input.destinationVariantId) || existing.warehouseId === input.warehouseId.trim())
        && (!existing.wasteBaseQuantity || existing.wasteReason === wasteReason);
      if (!sameRequest) return { ok: false, error: { type: "conflict", message: "idempotencyKey was already used for a different stock conversion" } };
      return {
        ok: true,
        value: {
          conversionId: existing.id,
          sourceBalanceAfter: existing.sourceBalanceAfter,
          outputBalanceAfter: existing.outputBalanceAfter,
          wasteBaseQuantity: existing.wasteBaseQuantity,
        },
      };
    }

    const requestedWarehouseId = input.warehouseId?.trim() || null;
    if (requestedWarehouseId) {
      const warehouse = await prisma.warehouse.findFirst({ where: { id: requestedWarehouseId, storeId }, select: { id: true } });
      if (!warehouse) return { ok: false, error: { type: "not_found", message: "Warehouse not found" } };
    }

    let result: InventoryResult<{ conversionId: string; sourceBalanceAfter: number; outputBalanceAfter: number; wasteBaseQuantity: number }>;
    try {
      result = await prisma.$transaction(async (tx) => {
        const [sourceProduct, destinationProduct] = await Promise.all([
          tx.product.findFirst({ where: { id: input.sourceProductId, storeId, isActive: true } }),
          tx.product.findFirst({ where: { id: input.destinationProductId, storeId, isActive: true } }),
        ]);
        if (!sourceProduct || !destinationProduct) {
          return { ok: false, error: { type: "not_found", message: "Source or destination product not found" } };
        }

        const [sourceVariant, destinationVariant] = await Promise.all([
          input.sourceVariantId
            ? tx.productVariant.findFirst({ where: { id: input.sourceVariantId, storeId, productId: sourceProduct.id, isActive: true } })
            : Promise.resolve(null),
          input.destinationVariantId
            ? tx.productVariant.findFirst({ where: { id: input.destinationVariantId, storeId, productId: destinationProduct.id, isActive: true } })
            : Promise.resolve(null),
        ]);
        if ((input.sourceVariantId && !sourceVariant) || (input.destinationVariantId && !destinationVariant)) {
          return { ok: false, error: { type: "not_found", message: "Source or destination variant not found" } };
        }

        const stockBaseUnit = sourceProduct.stockBaseUnit?.trim() ?? "";
        const destinationBaseUnit = destinationProduct.stockBaseUnit?.trim() ?? "";
        const sourceFamily = sourceProduct.stockConversionFamily?.trim().toLowerCase() ?? "";
        const destinationFamily = destinationProduct.stockConversionFamily?.trim().toLowerCase() ?? "";
        const sourceBaseQuantity = sourceVariant?.stockBaseQuantity ?? sourceProduct.stockBaseQuantity;
        const destinationBaseQuantity = destinationVariant?.stockBaseQuantity ?? destinationProduct.stockBaseQuantity;
        if (!stockBaseUnit || !destinationBaseUnit || stockBaseUnit !== destinationBaseUnit) {
          return { ok: false, error: { type: "validation", errors: ["source and destination must use the same configured conversion unit"] } };
        }
        if (!sourceFamily || !destinationFamily || sourceFamily !== destinationFamily) {
          return { ok: false, error: { type: "validation", errors: ["source and destination must belong to the same configured conversion family"] } };
        }
        if (!["g", "ml", "each"].includes(stockBaseUnit)) {
          return { ok: false, error: { type: "validation", errors: ["stock conversion unit is unsupported"] } };
        }
        if (!sourceBaseQuantity || !destinationBaseQuantity) {
          return { ok: false, error: { type: "validation", errors: ["configure contents per sellable unit for both stock items before converting"] } };
        }

        const sourceCostMinor = sourceVariant?.costMinor ?? sourceProduct.costMinor;
        let plan;
        try {
          plan = planStockConversion({
            sourceQuantity: input.sourceQuantity,
            outputQuantity: input.outputQuantity,
            sourceBaseQuantity,
            destinationBaseQuantity,
            sourceCostMinor,
            wasteReason,
          });
        } catch (e) {
          return { ok: false, error: { type: "validation", errors: [e instanceof Error ? e.message : "Invalid conversion"] } };
        }

        const needsWarehouse = !sourceVariant || !destinationVariant;
        const defaultWarehouse = needsWarehouse && !requestedWarehouseId
          ? await tx.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } })
          : null;
        const warehouseId = needsWarehouse ? (requestedWarehouseId ?? defaultWarehouse?.id ?? null) : null;

        let sourceBalanceAfter: number;
        let sourceWarehouseId: string | null = null;
        if (sourceVariant) {
          if (sourceVariant.quantityOnHand - sourceVariant.quantityReserved < input.sourceQuantity) {
            return { ok: false, error: { type: "conflict", message: "Not enough unreserved source stock" } };
          }
          const changed = await tx.productVariant.updateMany({
            where: {
              id: sourceVariant.id,
              storeId,
              quantityOnHand: sourceVariant.quantityOnHand,
              quantityReserved: sourceVariant.quantityReserved,
            },
            data: { quantityOnHand: { decrement: input.sourceQuantity } },
          });
          if (changed.count !== 1) throw new StockConversionConflictError("Source variant stock changed concurrently; refresh and retry");
          sourceBalanceAfter = sourceVariant.quantityOnHand - input.sourceQuantity;
        } else {
          const sourceLevel = await tx.stockLevel.findFirst({ where: { storeId, productId: sourceProduct.id, warehouseId } });
          if (!sourceLevel) return { ok: false, error: { type: "conflict", message: "Source product has no stock level in the selected warehouse" } };
          if (sourceLevel.quantityOnHand - sourceLevel.quantityReserved < input.sourceQuantity) {
            return { ok: false, error: { type: "conflict", message: "Not enough unreserved source stock in the selected warehouse" } };
          }
          const changed = await tx.stockLevel.updateMany({
            where: { id: sourceLevel.id, quantityOnHand: sourceLevel.quantityOnHand, quantityReserved: sourceLevel.quantityReserved },
            data: { quantityOnHand: { decrement: input.sourceQuantity } },
          });
          if (changed.count !== 1) throw new StockConversionConflictError("Source product stock changed concurrently; refresh and retry");
          sourceBalanceAfter = sourceLevel.quantityOnHand - input.sourceQuantity;
          sourceWarehouseId = sourceLevel.warehouseId;
        }

        let outputBalanceAfter: number;
        let destinationWarehouseId: string | null = null;
        let destinationOldQuantity: number;
        let destinationOldCostMinor: number;
        if (destinationVariant) {
          destinationOldQuantity = destinationVariant.quantityOnHand;
          destinationOldCostMinor = destinationVariant.costMinor;
          const nextQuantity = destinationVariant.quantityOnHand + input.outputQuantity;
          if (nextQuantity > 2_147_483_647) throw new StockConversionConflictError("Destination variant stock exceeds the supported range");
          const weightedCost = weightedUnitCost(destinationOldQuantity, destinationOldCostMinor, input.outputQuantity, plan.outputValueMinor);
          const changed = await tx.productVariant.updateMany({
            where: {
              id: destinationVariant.id,
              storeId,
              quantityOnHand: destinationVariant.quantityOnHand,
              quantityReserved: destinationVariant.quantityReserved,
            },
            data: { quantityOnHand: { increment: input.outputQuantity }, costMinor: weightedCost },
          });
          if (changed.count !== 1) throw new StockConversionConflictError("Destination variant stock changed concurrently; retry the conversion");
          outputBalanceAfter = nextQuantity;
        } else {
          const destinationLevels = await tx.stockLevel.findMany({ where: { storeId, productId: destinationProduct.id } });
          destinationOldQuantity = destinationLevels.reduce((sum, level) => sum + level.quantityOnHand, 0);
          destinationOldCostMinor = destinationProduct.costMinor;
          const targetLevel = destinationLevels.find((level) => level.warehouseId === warehouseId);
          if (targetLevel) {
            const nextQuantity = targetLevel.quantityOnHand + input.outputQuantity;
            if (nextQuantity > 2_147_483_647) throw new StockConversionConflictError("Destination product stock exceeds the supported range");
            const changed = await tx.stockLevel.updateMany({
              where: { id: targetLevel.id, quantityOnHand: targetLevel.quantityOnHand, quantityReserved: targetLevel.quantityReserved },
              data: { quantityOnHand: { increment: input.outputQuantity } },
            });
            if (changed.count !== 1) throw new StockConversionConflictError("Destination product stock changed concurrently; retry the conversion");
            outputBalanceAfter = nextQuantity;
            destinationWarehouseId = targetLevel.warehouseId;
          } else {
            const created = await tx.stockLevel.create({
              data: { storeId, productId: destinationProduct.id, warehouseId, quantityOnHand: input.outputQuantity, quantityReserved: 0 },
            });
            outputBalanceAfter = created.quantityOnHand;
            destinationWarehouseId = created.warehouseId;
          }
          const weightedCost = weightedUnitCost(destinationOldQuantity, destinationOldCostMinor, input.outputQuantity, plan.outputValueMinor);
          await tx.product.update({ where: { id: destinationProduct.id }, data: { costMinor: weightedCost } });
        }

        const conversion = await tx.stockConversion.create({
          data: {
            storeId,
            sourceProductId: sourceProduct.id,
            sourceVariantId: sourceVariant?.id ?? null,
            destinationProductId: destinationProduct.id,
            destinationVariantId: destinationVariant?.id ?? null,
            warehouseId: sourceWarehouseId ?? destinationWarehouseId ?? warehouseId,
            sourceQuantity: input.sourceQuantity,
            outputQuantity: input.outputQuantity,
            stockBaseUnit,
            conversionFamily: sourceFamily,
            sourceBaseQuantity,
            destinationBaseQuantity,
            wasteBaseQuantity: plan.wasteBaseQuantity,
            sourceValueMinor: plan.sourceValueMinor,
            outputValueMinor: plan.outputValueMinor,
            wasteValueMinor: plan.wasteValueMinor,
            idempotencyKey,
            sourceBalanceAfter,
            outputBalanceAfter,
            reason,
            wasteReason: plan.wasteBaseQuantity > 0 ? wasteReason : null,
            createdBy: actorId,
          },
        });

        await recordMovement(tx, {
          storeId,
          productId: sourceProduct.id,
          variantId: sourceVariant?.id ?? null,
          warehouseId: sourceWarehouseId,
          delta: -input.sourceQuantity,
          type: "CONVERSION_OUT",
          conversionId: conversion.id,
          createdBy: actorId,
          note: reason,
          balanceAfter: sourceBalanceAfter,
        });
        await recordMovement(tx, {
          storeId,
          productId: destinationProduct.id,
          variantId: destinationVariant?.id ?? null,
          warehouseId: destinationWarehouseId,
          delta: input.outputQuantity,
          type: "CONVERSION_IN",
          conversionId: conversion.id,
          createdBy: actorId,
          note: reason,
          balanceAfter: outputBalanceAfter,
        });
        await tx.auditLog.create({
          data: {
            storeId,
            actorType: "USER",
            actorId,
            action: "stock.convert",
            entityType: "StockConversion",
            entityId: conversion.id,
            after: {
              sourceProductId: sourceProduct.id,
              sourceVariantId: sourceVariant?.id ?? null,
              sourceQuantity: input.sourceQuantity,
              destinationProductId: destinationProduct.id,
              destinationVariantId: destinationVariant?.id ?? null,
              outputQuantity: input.outputQuantity,
              stockBaseUnit,
              wasteBaseQuantity: plan.wasteBaseQuantity,
              wasteReason: plan.wasteBaseQuantity > 0 ? wasteReason : null,
              reason,
            } as object,
          },
        });

        return {
          ok: true,
          value: { conversionId: conversion.id, sourceBalanceAfter, outputBalanceAfter, wasteBaseQuantity: plan.wasteBaseQuantity },
        };
      }, { timeout: 30_000, isolationLevel: "Serializable" });
    } catch (e) {
      if (e instanceof StockConversionConflictError) {
        return { ok: false, error: { type: "conflict", message: e.message } };
      }
      if (typeof e === "object" && e !== null && "code" in e && e.code === "P2002") {
        const prior = await prisma.stockConversion.findUnique({ where: { idempotencyKey } });
        if (prior
          && prior.storeId === storeId
          && prior.sourceProductId === input.sourceProductId
          && prior.sourceVariantId === (input.sourceVariantId ?? null)
          && prior.destinationProductId === input.destinationProductId
          && prior.destinationVariantId === (input.destinationVariantId ?? null)
          && prior.sourceQuantity === input.sourceQuantity
          && prior.outputQuantity === input.outputQuantity
          && prior.reason === reason
          && (!input.warehouseId?.trim() || (input.sourceVariantId && input.destinationVariantId) || prior.warehouseId === input.warehouseId.trim())) {
          return { ok: true, value: { conversionId: prior.id, sourceBalanceAfter: prior.sourceBalanceAfter, outputBalanceAfter: prior.outputBalanceAfter, wasteBaseQuantity: prior.wasteBaseQuantity } };
        }
        return { ok: false, error: { type: "conflict", message: "idempotencyKey was already used for a different stock conversion" } };
      }
      if (typeof e === "object" && e !== null && "code" in e && e.code === "P2034") {
        return { ok: false, error: { type: "conflict", message: "Stock changed concurrently; refresh and retry the conversion" } };
      }
      throw e;
    }

    if (result.ok) {
      await cacheBust(cacheKey("products", storeId));
      await cacheBust(cacheKey("inventory", storeId));
    }
    return result;
  }

  /** M2: adjustment history — every ADJUST movement, newest first. */
  async adjustments(storeId: string, filters: { productId?: string; from?: string; to?: string; limit?: number } = {}) {
    return this.movements(storeId, { ...filters, type: "ADJUST" });
  }

  /** M2: the stock flow — the raw ledger (any type), newest first, with actor + balance. */
  async movements(
    storeId: string,
    filters: { productId?: string; type?: string; from?: string; to?: string; limit?: number; actorId?: string } = {},
  ) {
    const where: Record<string, unknown> = { storeId };
    if (filters.productId) where.productId = filters.productId;
    if (filters.type) where.type = filters.type;
    if (filters.actorId) where.createdBy = filters.actorId;
    if (filters.from || filters.to) {
      const range: Record<string, Date> = {};
      if (filters.from) range.gte = new Date(filters.from);
      if (filters.to) range.lte = new Date(filters.to);
      where.createdAt = range;
    }
    const take = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const rows = await prisma.stockMovement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true, productId: true, variantId: true, warehouseId: true, delta: true, type: true, conversionId: true,
        note: true, createdBy: true, balanceAfter: true, createdAt: true,
        product: { select: { name: true, sku: true } },
        orderId: true,
      },
    });
    const actorIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => Boolean(x)))];
    const variantIds = [...new Set(rows.map((r) => r.variantId).filter((x): x is string => Boolean(x)))];
    const actors = actorIds.length
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
      : [];
    const variants = variantIds.length
      ? await prisma.productVariant.findMany({ where: { id: { in: variantIds }, storeId }, select: { id: true, name: true, sku: true } })
      : [];
    const nameOf = new Map(actors.map((a) => [a.id, a.name ?? a.email]));
    const variantOf = new Map(variants.map((v) => [v.id, v]));
    return {
      movements: rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        productName: r.product?.name ?? "(deleted product)",
        sku: r.product?.sku ?? null,
        variantName: r.variantId ? variantOf.get(r.variantId)?.name ?? null : null,
        variantSku: r.variantId ? variantOf.get(r.variantId)?.sku ?? null : null,
        warehouseId: r.warehouseId,
        delta: r.delta,
        type: r.type,
        note: r.note,
        balanceAfter: r.balanceAfter,
        orderId: r.orderId,
        conversionId: r.conversionId,
        actor: r.createdBy ? (nameOf.get(r.createdBy) ?? r.createdBy) : null,
        actorId: r.createdBy,
        createdAt: r.createdAt.toISOString(),
      })),
      count: rows.length,
    };
  }
}
