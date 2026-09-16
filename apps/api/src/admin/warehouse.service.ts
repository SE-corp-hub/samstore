// Warehouse & stock-transfer service.
// Multi-warehouse inventory: warehouses per store, product stock per warehouse,
// and a REQUESTED → APPROVED → IN_TRANSIT → COMPLETED transfer workflow (role-gated).

import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type WarehouseResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export class WarehouseService {
  async list(storeId: string) {
    const warehouses = await prisma.warehouse.findMany({
      where: { storeId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { stockLevels: true } } },
    });
    return warehouses.map((w) => ({ id: w.id, name: w.name, isDefault: w.isDefault, stockCount: w._count.stockLevels }));
  }

  async create(storeId: string, name: string): Promise<WarehouseResult<{ id: string }>> {
    const clean = name?.trim() ?? "";
    if (clean.length < 2) return { ok: false, error: { type: "validation", errors: ["Warehouse name must be at least 2 characters"] } };
    const existing = await prisma.warehouse.findFirst({ where: { storeId, name: clean } });
    if (existing) return { ok: false, error: { type: "conflict", message: "A warehouse with this name already exists" } };

    // First warehouse becomes the default.
    const count = await prisma.warehouse.count({ where: { storeId } });
    const warehouse = await prisma.warehouse.create({
      data: { storeId, name: clean, isDefault: count === 0 },
    });
    return { ok: true, value: { id: warehouse.id } };
  }

  /** Set a product's on-hand stock at a warehouse (upsert). */
  async setStock(storeId: string, warehouseId: string, productId: string, quantityOnHand: number): Promise<WarehouseResult<{ id: string }>> {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, storeId } });
    if (!warehouse) return { ok: false, error: { type: "not_found", message: "Warehouse not found" } };
    const product = await prisma.product.findFirst({ where: { id: productId, storeId } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    if (!Number.isInteger(quantityOnHand) || quantityOnHand < 0) {
      return { ok: false, error: { type: "validation", errors: ["quantityOnHand must be a non-negative integer"] } };
    }

    // Upsert by (warehouse, product): find then create/update. + ledger (ADJUST delta)
    const existing = await prisma.stockLevel.findFirst({ where: { storeId, productId, warehouseId } });
    if (existing) {
      const delta = quantityOnHand - existing.quantityOnHand;
      const updated = await prisma.stockLevel.update({ where: { id: existing.id }, data: { quantityOnHand } });
      if (delta !== 0) {
        await prisma.stockMovement.create({
          data: { storeId, productId, warehouseId, delta, type: "ADJUST", orderId: null, createdBy: null, note: "manual stock set", balanceAfter: updated.quantityOnHand },
        });
      }
    } else {
      const created = await prisma.stockLevel.create({
        data: { storeId, productId, warehouseId, quantityOnHand },
      });
      await prisma.stockMovement.create({
        data: { storeId, productId, warehouseId, delta: quantityOnHand, type: "ADJUST", orderId: null, createdBy: null, note: "manual stock set", balanceAfter: created.quantityOnHand },
      });
    }
    return { ok: true, value: { id: productId } };
  }

  /** Request a transfer (requester is any admin; approval required to complete). */
  async requestTransfer(
    storeId: string,
    fromWarehouseId: string,
    toWarehouseId: string,
    productId: string,
    quantity: number,
    requestedById: string,
    reason?: string,
  ): Promise<WarehouseResult<{ id: string }>> {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { ok: false, error: { type: "validation", errors: ["quantity must be a positive integer"] } };
    }
    if (fromWarehouseId === toWarehouseId) {
      return { ok: false, error: { type: "validation", errors: ["From and to warehouse must differ"] } };
    }
    const from = await prisma.warehouse.findFirst({ where: { id: fromWarehouseId, storeId } });
    const to = await prisma.warehouse.findFirst({ where: { id: toWarehouseId, storeId } });
    if (!from || !to) return { ok: false, error: { type: "not_found", message: "Warehouse not found" } };
    const product = await prisma.product.findFirst({ where: { id: productId, storeId } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };

    // Sufficient stock at the source?
    const level = await prisma.stockLevel.findFirst({ where: { storeId, productId, warehouseId: fromWarehouseId } });
    const available = (level?.quantityOnHand ?? 0) - (level?.quantityReserved ?? 0);
    if (available < quantity) {
      return { ok: false, error: { type: "conflict", message: `Insufficient stock at ${from.name} (${available} available)` } };
    }

    const transfer = await prisma.stockTransfer.create({
      data: {
        storeId,
        fromWarehouseId,
        toWarehouseId,
        productId,
        quantity,
        status: "REQUESTED",
        requestedById,
        reason: reason?.trim() ?? null,
      },
    });
    return { ok: true, value: { id: transfer.id } };
  }

  /** Approve a transfer (owner/manager; moves to APPROVED then IN_TRANSIT → COMPLETED moves stock). */
  async approveTransfer(storeId: string, transferId: string, approvedById: string): Promise<WarehouseResult<{ id: string; status: string }>> {
    const transfer = await prisma.stockTransfer.findFirst({ where: { id: transferId, storeId } });
    if (!transfer) return { ok: false, error: { type: "not_found", message: "Transfer not found" } };
    if (transfer.status !== "REQUESTED") return { ok: false, error: { type: "conflict", message: "Transfer is not in REQUESTED state" } };

    const updated = await prisma.stockTransfer.update({
      where: { id: transferId },
      data: { status: "APPROVED", approvedById },
    });
    return { ok: true, value: { id: transferId, status: updated.status } };
  }

  /** Complete a transfer: moves quantity from source to destination warehouse. */
  async completeTransfer(storeId: string, transferId: string): Promise<WarehouseResult<{ id: string; status: string }>> {
    const transfer = await prisma.stockTransfer.findFirst({ where: { id: transferId, storeId }, include: { fromWarehouse: true, toWarehouse: true } });
    if (!transfer) return { ok: false, error: { type: "not_found", message: "Transfer not found" } };
    if (!["APPROVED", "IN_TRANSIT"].includes(transfer.status)) {
      return { ok: false, error: { type: "conflict", message: `Transfer cannot be completed from ${transfer.status}` } };
    }

    await prisma.$transaction(async (tx) => {
      // Decrement source + ledger
      const fromLevel = await tx.stockLevel.findFirst({ where: { storeId, productId: transfer.productId, warehouseId: transfer.fromWarehouseId } });
      if (fromLevel) {
        const updated = await tx.stockLevel.update({
          where: { id: fromLevel.id },
          data: { quantityOnHand: { decrement: transfer.quantity } },
        });
        await tx.stockMovement.create({
          data: { storeId, productId: transfer.productId, warehouseId: transfer.fromWarehouseId, delta: -transfer.quantity, type: "TRANSFER_OUT", orderId: null, createdBy: null, note: `transfer ${transfer.id}`, balanceAfter: updated.quantityOnHand },
        });
      }
      // Increment destination (upsert) + ledger
      const dest = await tx.stockLevel.findFirst({ where: { storeId, productId: transfer.productId, warehouseId: transfer.toWarehouseId } });
      if (dest) {
        const updated = await tx.stockLevel.update({ where: { id: dest.id }, data: { quantityOnHand: { increment: transfer.quantity } } });
        await tx.stockMovement.create({
          data: { storeId, productId: transfer.productId, warehouseId: transfer.toWarehouseId, delta: transfer.quantity, type: "TRANSFER_IN", orderId: null, createdBy: null, note: `transfer ${transfer.id}`, balanceAfter: updated.quantityOnHand },
        });
      } else {
        const created = await tx.stockLevel.create({
          data: { storeId, productId: transfer.productId, warehouseId: transfer.toWarehouseId, quantityOnHand: transfer.quantity },
        });
        await tx.stockMovement.create({
          data: { storeId, productId: transfer.productId, warehouseId: transfer.toWarehouseId, delta: transfer.quantity, type: "TRANSFER_IN", orderId: null, createdBy: null, note: `transfer ${transfer.id}`, balanceAfter: created.quantityOnHand },
        });
      }
      await tx.stockTransfer.update({
        where: { id: transferId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
    });

    return { ok: true, value: { id: transferId, status: "COMPLETED" } };
  }

  async listTransfers(storeId: string) {
    return prisma.stockTransfer.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      include: { fromWarehouse: { select: { name: true } }, toWarehouse: { select: { name: true } }, product: { select: { name: true, sku: true } }, requestedBy: { select: { email: true } } },
    });
  }

  /** Stock breakdown per warehouse for a product (read for the UI). */
  async stockByWarehouse(storeId: string, productId: string) {
    return prisma.stockLevel.findMany({
      where: { storeId, productId },
      include: { warehouse: { select: { id: true, name: true } } },
    });
  }
}