// Purchases & replenishment.
// - Purchase + PurchaseItem store supplier/cost records.
// - Completing a purchase ADDS stock (default warehouse) and updates product costMinor (COGS feed).
// - Replenishment list: products with available ≤ reorder threshold → one-tap purchase.

import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";

export type PurchaseResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const PURCHASES_SERVICE = Symbol("PURCHASES_SERVICE");

export class PurchasesService {
  async create(storeId: string, actorId: string, input: { vendor?: string; supplierId?: string; note?: string; items: { productId: string; quantity: number; costMinor: number }[] }): Promise<PurchaseResult<{ id: string; totalCostMinor: number }>> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      return { ok: false, error: { type: "validation", errors: ["At least one purchase item is required"] } };
    }
    for (const it of input.items) {
      if (!Number.isInteger(it.quantity) || it.quantity <= 0 || it.quantity > 9999) {
        return { ok: false, error: { type: "validation", errors: ["quantity must be a positive integer (max 9999)"] } };
      }
      if (!Number.isInteger(it.costMinor) || it.costMinor < 0) {
        return { ok: false, error: { type: "validation", errors: ["costMinor must be a non-negative integer"] } };
      }
    }

    // Resolve supplierId + vendor text
    let vendorId: string | null = null;
    let vendorText: string | null = null;
    if (input.supplierId) {
      const supplier = await prisma.supplier.findFirst({ where: { id: input.supplierId, storeId }, select: { id: true, name: true } });
      if (!supplier) return { ok: false, error: { type: "not_found", message: "Supplier not found in this store" } };
      vendorId = supplier.id;
      vendorText = supplier.name;
    } else if (input.vendor) {
      vendorText = input.vendor.trim() || null;
    }

    // Products must belong to the store
    const ids = input.items.map((i) => i.productId);
    const products = await prisma.product.findMany({ where: { storeId, id: { in: ids } }, select: { id: true } });
    if (products.length !== new Set(ids).size) {
      return { ok: false, error: { type: "not_found", message: "One or more products not found in this store" } };
    }

    const totalCostMinor = input.items.reduce((s, i) => s + i.quantity * i.costMinor, 0);
    const defaultWarehouse = await prisma.warehouse.findFirst({ where: { storeId, isDefault: true } });

    const purchase = await prisma.$transaction(async (tx) => {
      const p = await tx.purchase.create({
        data: {
          storeId,
          vendor: vendorText,
          vendorId,
          note: input.note?.trim() ?? null,
          totalCostMinor,
          createdBy: actorId,
          items: {
            create: input.items.map((i) => ({
              storeId,
              productId: i.productId,
              quantity: i.quantity,
              costMinor: i.costMinor,
              lineCostMinor: i.quantity * i.costMinor,
            })),
          },
        },
      });
      for (const it of input.items) {
        const level = defaultWarehouse
          ? await tx.stockLevel.findFirst({ where: { storeId, productId: it.productId, warehouseId: defaultWarehouse.id } })
          : await tx.stockLevel.findFirst({ where: { storeId, productId: it.productId, warehouseId: null } });
        let balanceAfter: number;
        if (level) {
          const updated = await tx.stockLevel.update({ where: { id: level.id }, data: { quantityOnHand: { increment: it.quantity } } });
          balanceAfter = updated.quantityOnHand;
        } else {
          const created = await tx.stockLevel.create({
            data: {
              storeId,
              productId: it.productId,
              warehouseId: defaultWarehouse?.id ?? null,
              quantityOnHand: it.quantity,
              quantityReserved: 0,
            },
          });
          balanceAfter = created.quantityOnHand;
        }
        await tx.stockMovement.create({
          data: {
            storeId,
            productId: it.productId,
            warehouseId: defaultWarehouse?.id ?? null,
            delta: it.quantity,
            type: "RECEIPT",
            orderId: null,
            createdBy: actorId,
            note: "purchase received",
            balanceAfter,
          },
        });
        const before = await tx.product.findUnique({ where: { id: it.productId }, select: { costMinor: true } });
        if (before && before.costMinor !== it.costMinor) {
          await tx.priceHistory.create({ data: { storeId, productId: it.productId, field: "COST", oldMinor: before.costMinor, newMinor: it.costMinor, source: "PURCHASE", changedById: actorId ?? null } });
        }
        await tx.product.update({ where: { id: it.productId }, data: { costMinor: it.costMinor } });
      }
      return p;
    });
    await cacheBust(cacheKey("products", storeId));

    return { ok: true, value: { id: purchase.id, totalCostMinor } };
  }

  async list(storeId: string) {
    return prisma.purchase.findMany({
      where: { storeId },
      orderBy: { purchasedAt: "desc" },
      take: 100,
      include: { items: { include: { product: { select: { name: true, sku: true } } } }, supplier: { select: { name: true } } },
    });
  }

  /** Products needing replenishment: available <= reorder threshold (any warehouse). */
  async replenishmentList(storeId: string) {
    const products = await prisma.product.findMany({
      where: { storeId, isActive: true, stockLevels: { some: {} } },
      include: { stockLevels: true },
    });
    return products
      .map((p) => {
        const available = p.stockLevels.reduce((s, l) => s + (l.quantityOnHand - l.quantityReserved), 0);
        const threshold = Math.max(...p.stockLevels.map((l) => l.reorderThreshold), 0);
        return { id: p.id, name: p.name, sku: p.sku, availableQuantity: available, reorderThreshold: threshold };
      })
      .filter((p) => p.reorderThreshold > 0 && p.availableQuantity <= p.reorderThreshold)
      .sort((a, b) => a.availableQuantity - b.availableQuantity);
  }
}