// Inventory: aggregated per product across warehouses, with filters + value at cost.
// Filters: search (name/SKU), category, warehouse, stock status (in/low/out).
// Inventory value = Σ costMinor × quantityOnHand (cost from latest purchase).
//
// M2 adds the operator-facing ledger screens: a reasoned, actor-attributed adjustment
// (the ONE writer besides POS/checkout paths) and the history/flow reads over
// StockMovement. Balances stay derived — the movement row is the source of truth.

import { prisma } from "../persistence/prisma-repositories.js";
import { adjustStock, InsufficientStockError } from "../domain/movements.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import type { ApiError } from "@sam-store/contracts";

export const INVENTORY_SERVICE = Symbol("INVENTORY_SERVICE");

export type InventoryResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

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
      },
      orderBy: { name: "asc" },
    });

    const rows = products.map((p) => {
      const levels = filters.warehouseId ? p.stockLevels.filter((l) => l.warehouseId === filters.warehouseId) : p.stockLevels;
      const onHand = levels.reduce((s, l) => s + l.quantityOnHand, 0);
      const reserved = levels.reduce((s, l) => s + l.quantityReserved, 0);
      const threshold = Math.max(0, ...levels.map((l) => l.reorderThreshold));
      const available = onHand - reserved;
      let status: "in" | "low" | "out";
      if (available <= 0 && onHand <= 0) status = "out";
      else if (threshold > 0 && available <= threshold) status = "low";
      else status = "in";
      const valueMinor = onHand * p.costMinor;
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
        id: true, productId: true, warehouseId: true, delta: true, type: true,
        note: true, createdBy: true, balanceAfter: true, createdAt: true,
        product: { select: { name: true, sku: true } },
        orderId: true,
      },
    });
    const actorIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => Boolean(x)))];
    const actors = actorIds.length
      ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
      : [];
    const nameOf = new Map(actors.map((a) => [a.id, a.name ?? a.email]));
    return {
      movements: rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        productName: r.product?.name ?? "(deleted product)",
        sku: r.product?.sku ?? null,
        warehouseId: r.warehouseId,
        delta: r.delta,
        type: r.type,
        note: r.note,
        balanceAfter: r.balanceAfter,
        orderId: r.orderId,
        actor: r.createdBy ? (nameOf.get(r.createdBy) ?? r.createdBy) : null,
        actorId: r.createdBy,
        createdAt: r.createdAt.toISOString(),
      })),
      count: rows.length,
    };
  }
}