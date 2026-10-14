// Location (warehouse) & stock-transfer service.
//
// Rice Ops M1: a Warehouse row is a stock LOCATION of the business — a store
// counter (STORE) or the bulk warehouse (WAREHOUSE), with a short code (S1, WH)
// and an address. Transfers move stock between locations through ONE ledger
// writer (domain/movements.transferStock), with the status claimed atomically so
// a transfer can never complete twice, and never create stock the source lacks.

import { LocationType } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { adjustStock, InsufficientStockError, transferStock } from "../domain/movements.js";
import type { ApiError } from "@sam-store/contracts";
import { captureSignatures, locationRefusal, requireSignatures, signatureErrorResult, type Actor, type SignatureInput } from "../people/people.service.js";

export type WarehouseResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

const CODE_RE = /^[A-Z0-9]{1,6}$/;
const MAX_PRICE_MINOR = 100_000_000; // ₱1,000,000.00 — far above any sack price

/** Thrown inside a transaction when a transfer is no longer in a state that allows the step. */
class TransferStateError extends Error {}

export interface LocationInput {
  name?: string;
  type?: string;
  code?: string | null;
  address?: string | null;
  isActive?: boolean;
  isDefault?: boolean;
}

function validateLocation(input: LocationInput, creating: boolean): string[] {
  const errors: string[] = [];
  if (creating || input.name !== undefined) {
    const name = input.name?.trim() ?? "";
    if (name.length < 2 || name.length > 60) errors.push("Location name must be 2–60 characters");
  }
  if (input.type !== undefined && !(Object.values(LocationType) as string[]).includes(input.type)) {
    errors.push("type must be STORE or WAREHOUSE");
  }
  if (input.code !== undefined && input.code !== null && input.code !== "" && !CODE_RE.test(input.code.trim().toUpperCase())) {
    errors.push("code must be 1–6 letters or digits (e.g. S1, WH)");
  }
  if (input.address !== undefined && input.address !== null && input.address.length > 300) {
    errors.push("address must be at most 300 characters");
  }
  return errors;
}

function cleanCode(code: string | null | undefined): string | null {
  const c = code?.trim().toUpperCase() ?? "";
  return c.length ? c : null;
}

export class WarehouseService {
  async list(storeId: string) {
    const warehouses = await prisma.warehouse.findMany({
      where: { storeId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      include: { _count: { select: { stockLevels: true } } },
    });
    return warehouses.map((w) => ({
      id: w.id,
      name: w.name,
      code: w.code,
      type: w.type,
      address: w.address,
      isActive: w.isActive,
      isDefault: w.isDefault,
      stockCount: w._count.stockLevels,
    }));
  }

  async create(storeId: string, input: LocationInput | string): Promise<WarehouseResult<{ id: string }>> {
    const data: LocationInput = typeof input === "string" ? { name: input } : input ?? {};
    const errors = validateLocation(data, true);
    if (errors.length) return { ok: false, error: { type: "validation", errors } };
    const name = data.name!.trim();
    const code = cleanCode(data.code);
    const clash = await prisma.warehouse.findFirst({ where: { storeId, OR: [{ name }, ...(code ? [{ code }] : [])] } });
    if (clash) return { ok: false, error: { type: "conflict", message: clash.name === name ? "A location with this name already exists" : `Code ${code} is already used by ${clash.name}` } };

    // The first location becomes the default.
    const count = await prisma.warehouse.count({ where: { storeId } });
    const warehouse = await prisma.warehouse.create({
      data: {
        storeId,
        name,
        code,
        type: (data.type as LocationType | undefined) ?? LocationType.STORE,
        address: data.address?.trim() || null,
        isDefault: count === 0,
      },
    });
    return { ok: true, value: { id: warehouse.id } };
  }

  /** Rename / re-code / re-address a location, switch it on or off, or make it the default. */
  async update(storeId: string, warehouseId: string, input: LocationInput): Promise<WarehouseResult<{ id: string }>> {
    const current = await prisma.warehouse.findFirst({ where: { id: warehouseId, storeId } });
    if (!current) return { ok: false, error: { type: "not_found", message: "Location not found" } };
    const errors = validateLocation(input ?? {}, false);
    if (errors.length) return { ok: false, error: { type: "validation", errors } };
    if (input.isActive === false && (current.isDefault || input.isDefault === true)) {
      return { ok: false, error: { type: "conflict", message: "The default location cannot be switched off; make another location the default first" } };
    }
    if (input.isDefault === false && current.isDefault) {
      return { ok: false, error: { type: "conflict", message: "Choose a new default location instead of clearing this one" } };
    }
    const name = input.name?.trim();
    const code = input.code === undefined ? undefined : cleanCode(input.code);
    if (name && name !== current.name) {
      const clash = await prisma.warehouse.findFirst({ where: { storeId, name, NOT: { id: warehouseId } } });
      if (clash) return { ok: false, error: { type: "conflict", message: "A location with this name already exists" } };
    }
    if (code) {
      const clash = await prisma.warehouse.findFirst({ where: { storeId, code, NOT: { id: warehouseId } } });
      if (clash) return { ok: false, error: { type: "conflict", message: `Code ${code} is already used by ${clash.name}` } };
    }
    await prisma.$transaction(async (tx) => {
      if (input.isDefault === true && !current.isDefault) {
        await tx.warehouse.updateMany({ where: { storeId, isDefault: true }, data: { isDefault: false } });
      }
      await tx.warehouse.update({
        where: { id: warehouseId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(code !== undefined ? { code } : {}),
          ...(input.type !== undefined ? { type: input.type as LocationType } : {}),
          ...(input.address !== undefined ? { address: input.address?.trim() || null } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.isDefault === true ? { isDefault: true } : {}),
        },
      });
    });
    return { ok: true, value: { id: warehouseId } };
  }

  /**
   * Set a product's counted on-hand stock at a location. Rice Ops M1: this is a
   * reasoned, actor-attributed ADJUST through the ledger (adjustStock), never a
   * silent overwrite.
   */
  async setStock(
    storeId: string,
    warehouseId: string,
    productId: string,
    quantityOnHand: number,
    actorId: string,
    reason: string,
  ): Promise<WarehouseResult<{ id: string; balanceAfter: number; delta: number }>> {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, storeId } });
    if (!warehouse) return { ok: false, error: { type: "not_found", message: "Location not found" } };
    const product = await prisma.product.findFirst({ where: { id: productId, storeId }, select: { id: true } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    if (!Number.isInteger(quantityOnHand) || quantityOnHand < 0) {
      return { ok: false, error: { type: "validation", errors: ["quantityOnHand must be a non-negative integer"] } };
    }
    const why = reason?.trim() ?? "";
    if (why.length < 3) return { ok: false, error: { type: "validation", errors: ["A reason is required (at least 3 characters)"] } };

    const out = await prisma.$transaction((tx) =>
      adjustStock(tx, { storeId, productId, warehouseId, setTo: quantityOnHand, reason: why, actorId, documentType: "STOCK_SET" }),
    );
    await prisma.auditLog.create({
      data: { storeId, actorType: "USER", actorId, action: "stock.set", entityType: "StockLevel", entityId: out.levelId, after: { warehouseId, productId, quantityOnHand, delta: out.delta, reason: why } },
    });
    return { ok: true, value: { id: productId, balanceAfter: out.balanceAfter, delta: out.delta } };
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
      return { ok: false, error: { type: "validation", errors: ["From and to location must differ"] } };
    }
    const from = await prisma.warehouse.findFirst({ where: { id: fromWarehouseId, storeId } });
    const to = await prisma.warehouse.findFirst({ where: { id: toWarehouseId, storeId } });
    if (!from || !to) return { ok: false, error: { type: "not_found", message: "Location not found" } };
    if (!from.isActive || !to.isActive) return { ok: false, error: { type: "conflict", message: "Inactive locations cannot send or receive stock" } };
    const product = await prisma.product.findFirst({ where: { id: productId, storeId } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };

    // Sufficient AVAILABLE stock at the source? (Re-checked atomically at completion.)
    const level = await prisma.stockLevel.findFirst({ where: { storeId, productId, warehouseId: fromWarehouseId } });
    const available = (level?.quantityOnHand ?? 0) - (level?.quantityReserved ?? 0);
    if (available < quantity) {
      return { ok: false, error: { type: "conflict", message: `Insufficient stock at ${from.name} (${Math.max(0, available)} available)` } };
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
        reason: reason?.trim() || null,
      },
    });
    return { ok: true, value: { id: transfer.id } };
  }

  /** Approve a REQUESTED transfer. The status is claimed atomically (no double approval). */
  async approveTransfer(storeId: string, transferId: string, approvedById: string): Promise<WarehouseResult<{ id: string; status: string }>> {
    const claimed = await prisma.stockTransfer.updateMany({
      where: { id: transferId, storeId, status: "REQUESTED" },
      data: { status: "APPROVED", approvedById },
    });
    if (claimed.count === 0) {
      const exists = await prisma.stockTransfer.findFirst({ where: { id: transferId, storeId }, select: { status: true } });
      if (!exists) return { ok: false, error: { type: "not_found", message: "Transfer not found" } };
      return { ok: false, error: { type: "conflict", message: `Transfer is ${exists.status}, not REQUESTED` } };
    }
    return { ok: true, value: { id: transferId, status: "APPROVED" } };
  }

  /**
   * Complete a transfer: move the stock from source to destination.
   * Rice Ops M1 fixes:
   *   * the status is claimed with one conditional UPDATE inside the transaction,
   *     so two concurrent completions move the stock exactly once;
   *   * the source is decremented against AVAILABLE stock (guarded), so a
   *     transfer can never create stock the source does not have;
   *   * both ledger rows carry the actor and the transfer id.
   */
  /**
   * Receive a transfer at its destination. Rice Ops M2: the receiving staff signs
   * (step TRANSFER:RECEIVE) in the same transaction; without the signature nothing
   * moves. The receiver must be allowed to act at the destination location.
   */
  async completeTransfer(
    storeId: string,
    transferId: string,
    actor: Actor,
    signatures: SignatureInput[] = [],
  ): Promise<WarehouseResult<{ id: string; status: string }>> {
    const actorId = actor.userId;
    const transfer = await prisma.stockTransfer.findFirst({ where: { id: transferId, storeId }, include: { fromWarehouse: true, toWarehouse: true } });
    if (!transfer) return { ok: false, error: { type: "not_found", message: "Transfer not found" } };
    const refusal = locationRefusal(actor, transfer.toWarehouseId);
    if (refusal) return { ok: false, error: { type: "forbidden", message: refusal } };

    try {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.stockTransfer.updateMany({
          where: { id: transferId, storeId, status: { in: ["APPROVED", "IN_TRANSIT"] } },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
        if (claimed.count === 0) {
          const now = await tx.stockTransfer.findUnique({ where: { id: transferId }, select: { status: true } });
          throw new TransferStateError(`Transfer cannot be completed from ${now?.status ?? transfer.status}`);
        }
        const doc = { documentType: "TRANSFER", documentId: transfer.id, step: "RECEIVE" };
        await captureSignatures(tx, storeId, actor, { ...doc, locationId: transfer.toWarehouseId }, signatures);
        await requireSignatures(tx, storeId, doc);
        await transferStock(tx, {
          storeId,
          productId: transfer.productId,
          fromWarehouseId: transfer.fromWarehouseId,
          toWarehouseId: transfer.toWarehouseId,
          quantity: transfer.quantity,
          actorId,
          documentType: "TRANSFER",
          documentId: transfer.id,
          note: `transfer ${transfer.id}`,
        });
      });
    } catch (e) {
      if (e instanceof TransferStateError) return { ok: false, error: { type: "conflict", message: e.message } };
      const sig = signatureErrorResult(e);
      if (sig) return sig;
      if (e instanceof InsufficientStockError) {
        return { ok: false, error: { type: "conflict", message: `Not enough stock at ${transfer.fromWarehouse.name} to complete this transfer (short by ${e.shortfall})` } };
      }
      throw e;
    }
    return { ok: true, value: { id: transferId, status: "COMPLETED" } };
  }

  /** Cancel a transfer that has not moved stock yet (REQUESTED or APPROVED). */
  async cancelTransfer(storeId: string, transferId: string, actorId: string, reason?: string): Promise<WarehouseResult<{ id: string; status: string }>> {
    const claimed = await prisma.stockTransfer.updateMany({
      where: { id: transferId, storeId, status: { in: ["REQUESTED", "APPROVED"] } },
      data: { status: "CANCELLED" },
    });
    if (claimed.count === 0) {
      const exists = await prisma.stockTransfer.findFirst({ where: { id: transferId, storeId }, select: { status: true } });
      if (!exists) return { ok: false, error: { type: "not_found", message: "Transfer not found" } };
      return { ok: false, error: { type: "conflict", message: `Transfer is ${exists.status} and can no longer be cancelled` } };
    }
    await prisma.auditLog.create({
      data: { storeId, actorType: "USER", actorId, action: "transfer.cancel", entityType: "StockTransfer", entityId: transferId, after: { reason: reason?.trim() || null } },
    });
    return { ok: true, value: { id: transferId, status: "CANCELLED" } };
  }

  async listTransfers(storeId: string) {
    return prisma.stockTransfer.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      include: {
        fromWarehouse: { select: { name: true, code: true } },
        toWarehouse: { select: { name: true, code: true } },
        product: { select: { name: true, sku: true } },
        requestedBy: { select: { email: true, name: true } },
        approvedBy: { select: { email: true, name: true } },
      },
    });
  }

  /** Stock breakdown per location for a product (read for the UI). */
  async stockByWarehouse(storeId: string, productId: string) {
    return prisma.stockLevel.findMany({
      where: { storeId, productId },
      include: { warehouse: { select: { id: true, name: true, code: true, type: true } } },
    });
  }

  // ─────────────────────────────── Location prices ───────────────────────────────

  /** Every active product with its main price and this location's own price (if any). */
  async listPrices(storeId: string, warehouseId: string): Promise<WarehouseResult<{ productId: string; name: string; sku: string; mainPriceMinor: number; locationPriceMinor: number | null; effectivePriceMinor: number }[]>> {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, storeId }, select: { id: true } });
    if (!warehouse) return { ok: false, error: { type: "not_found", message: "Location not found" } };
    const [products, prices] = await Promise.all([
      prisma.product.findMany({ where: { storeId, isActive: true }, select: { id: true, name: true, sku: true, priceMinor: true }, orderBy: { name: "asc" } }),
      prisma.locationPrice.findMany({ where: { storeId, warehouseId }, select: { productId: true, priceMinor: true } }),
    ]);
    const byProduct = new Map(prices.map((p) => [p.productId, p.priceMinor]));
    return {
      ok: true,
      value: products.map((p) => {
        const own = byProduct.get(p.id) ?? null;
        return { productId: p.id, name: p.name, sku: p.sku, mainPriceMinor: p.priceMinor, locationPriceMinor: own, effectivePriceMinor: own ?? p.priceMinor };
      }),
    };
  }

  /** Set (or with null, remove) a location's own selling price for a product. */
  async setPrice(storeId: string, warehouseId: string, productId: string, priceMinor: number | null, actorId: string): Promise<WarehouseResult<{ productId: string; warehouseId: string; priceMinor: number | null }>> {
    const warehouse = await prisma.warehouse.findFirst({ where: { id: warehouseId, storeId }, select: { id: true } });
    if (!warehouse) return { ok: false, error: { type: "not_found", message: "Location not found" } };
    const product = await prisma.product.findFirst({ where: { id: productId, storeId }, select: { id: true, priceMinor: true } });
    if (!product) return { ok: false, error: { type: "not_found", message: "Product not found" } };
    if (priceMinor !== null && (!Number.isInteger(priceMinor) || priceMinor <= 0 || priceMinor > MAX_PRICE_MINOR)) {
      return { ok: false, error: { type: "validation", errors: ["priceMinor must be a positive whole number of centavos (or null to use the main price)"] } };
    }
    const before = await prisma.locationPrice.findUnique({ where: { storeId_productId_warehouseId: { storeId, productId, warehouseId } } });
    if (priceMinor === null) {
      if (before) await prisma.locationPrice.delete({ where: { id: before.id } });
    } else {
      await prisma.locationPrice.upsert({
        where: { storeId_productId_warehouseId: { storeId, productId, warehouseId } },
        create: { storeId, productId, warehouseId, priceMinor, updatedBy: actorId },
        update: { priceMinor, updatedBy: actorId },
      });
    }
    await prisma.auditLog.create({
      data: { storeId, actorType: "USER", actorId, action: "price.location.set", entityType: "Product", entityId: productId, before: { warehouseId, priceMinor: before?.priceMinor ?? null }, after: { warehouseId, priceMinor } },
    });
    return { ok: true, value: { productId, warehouseId, priceMinor } };
  }
}
