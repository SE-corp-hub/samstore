// Order admin service — status transitions with the state machine + audit history.

import { availableOf } from "../domain/stock-tracking.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { deductStock, InsufficientStockError, restoreStock } from "../domain/movements.js";
import { dispositionForOrderStatus, hasActiveReservation, moveOrderReservation, settleForStatus } from "../domain/stock-settlement.js";
import { resolveLinePrice } from "../domain/price-override.js";
import { assertTransition, paymentEffectFor, type OrderState } from "../domain/order-state.js";
import { computeOrderTotals } from "../domain/pricing.js";
import { taxColumnsFor } from "../domain/tax-store.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import type { NotificationsService } from "../notifications/notifications.service.js";
import type { ApiError } from "@sam-store/contracts";

/** One line of an edited order: a changed price needs its reason (see domain/price-override). */
export interface OrderEditLine { productId: string; quantity: number; unitPriceMinorOverride?: number | null; priceOverrideReason?: string | null }

export type AdminResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export class OrderAdminService {
  constructor(private readonly notify?: NotificationsService) {}

/** M8: unified delivery signal — the EXPLICIT fulfillmentType (M3 backfilled from the
 *  address); the address is only a fallback for rows created before the backfill. */
  private isDeliveryOrder(order: { fulfillmentType?: string | null; deliveryType?: string | null; deliveryAddressLine1?: string | null }): boolean {
    if (order.fulfillmentType) return order.fulfillmentType === "DELIVERY";
    return Boolean(order.deliveryAddressLine1?.trim()) || order.deliveryType === "delivery";
  }
  /** Transition an order's status (forward state machine; reason for manual overrides). */
  async transition(
    storeId: string,
    orderId: string,
    toStatus: OrderState,
    reason?: string,
    actor?: { type: string; id: string | null },
  ): Promise<AdminResult<{ id: string; status: OrderState }>> {
    const order = await prisma.order.findFirst({ where: { id: orderId, storeId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };

    const from = order.status as OrderState;
    // Delivery orders must stay in the delivery pipeline — COMPLETED only via courier DELIVERED (or prepaid payment).
    if (toStatus === "COMPLETED" && this.isDeliveryOrder(order)) {
      return { ok: false, error: { type: "conflict", message: "Delivery orders must go through the delivery pipeline" } };
    }
    try {
      assertTransition(from, toStatus, reason);
    } catch (e) {
      return {
        ok: false,
        error: { type: "conflict", message: e instanceof Error ? e.message : "Invalid transition" },
      };
    }

    const paymentStatus = paymentEffectFor(toStatus, order.paymentStatus);

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: toStatus, paymentStatus: paymentStatus as never },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          storeId,
          fromStatus: from,
          toStatus,
          reason: reason?.trim() ?? null,
          actorType: actor?.type ?? "system",
          actorId: actor?.id ?? null,
        },
      });
      // Fulfilment consumes the checkout reservation; cancellation releases it.
      // Same transaction as the status change — never a half-applied outcome.
      await settleForStatus(tx, { id: orderId, storeId }, toStatus);
    });

    // Loyalty: award points when the order is delivered (and linked to a customer).
    if (toStatus === "DELIVERED") {
      await this.awardLoyalty(orderId);
    }

    // Notifications: status change → customer (Messenger suppressed until connected; SMS/email recorded).
    if (this.notify) {
      await this.notify.notify({
        storeId,
        customerPhone: order.customerPhone,
        psid: null, // no verified PSID yet — suppressed path
        template: toStatus === "OUT_FOR_DELIVERY" ? "order_out_for_delivery" : toStatus === "READY" ? "order_ready_for_pickup" : toStatus === "DELIVERED" ? "order_delivered" : "order_status",
        data: { orderNumber: order.orderNumber, status: toStatus },
      });
    }
    await cacheBust(cacheKey("orders", storeId));
    // Delivered / cancelled moves held stock: the product list must not show the old numbers.
    if (dispositionForOrderStatus(toStatus)) await cacheBust(cacheKey("products", storeId));
    return { ok: true, value: { id: orderId, status: toStatus } };
  }

  /** Award loyalty points for a delivered order (idempotent via LoyaltyEntry). */
  private async awardLoyalty(orderId: string): Promise<void> {
    const loyalty = new LoyaltyService();
    await loyalty.earnForDeliveredOrder(orderId);
  }

  /** Order detail with items + history (for the admin). */
  async detail(storeId: string, orderId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: {
        items: true,
        statusHistory: { orderBy: { createdAt: "asc" } },
        claimTokens: { select: { token: true, usedAt: true, expiresAt: true } },
      },
    });
    if (!order) return null;
    return order;
  }

  // ─────────────────────────────── W1: edit + routing ───────────────────────────────

  /** Editable statuses: RECEIVED | CONFIRMED | ON_HOLD | PREPARING | READY (on-process). */
  private static EDITABLE = ["RECEIVED", "CONFIRMED", "ON_HOLD", "PREPARING", "READY"];

  /**
   * W1: replace an order's items (Orders → Change items): add or remove products, change how many and the
   * price of each. A price that differs from the list price needs a reason (domain/price-override), like POS.
   * Stock follows the edit: an order that still HOLDS stock (online / SE Corp Hub checkout) moves its hold to
   * the new lines; any other order gives back its old lines and takes the new ones (stock delta).
   */
  async replaceOrderItems(storeId: string, orderId: string, items: OrderEditLine[], actorId: string | null = null): Promise<AdminResult<{ id: string; status: string; totalMinor: number }>> {
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, error: { type: "validation", errors: ["At least one item with positive quantity is required"] } };
    }
    for (const it of items) {
      if (!it || typeof it.productId !== "string" || !Number.isInteger(it.quantity) || it.quantity <= 0 || it.quantity > 999) {
        return { ok: false, error: { type: "validation", errors: ["quantity must be a positive whole number (max 999)"] } };
      }
    }
    if (new Set(items.map((i) => i.productId)).size !== items.length) {
      return { ok: false, error: { type: "validation", errors: ["Each product can be on the order only once"] } };
    }
    const order = await prisma.order.findFirst({ where: { storeId, id: orderId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (!OrderAdminService.EDITABLE.includes(order.status)) {
      return { ok: false, error: { type: "conflict", message: `Cannot edit an order in ${order.status}` } };
    }
    const reserved = await prisma.$transaction((tx) => hasActiveReservation(tx, storeId, orderId));

    // Fresh products + availability
    const ids = items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { storeId, id: { in: ids }, isActive: true },
      include: { stockLevels: true },
    });
    if (products.length !== ids.length) {
      return { ok: false, error: { type: "not_found", message: "One or more products not found or inactive" } };
    }
    const oldItems = await prisma.orderItem.findMany({ where: { orderId } });
    // What this order already has of a product counts as available to it (it holds or took those units).
    const mine = (productId: string) => oldItems.filter((o) => o.productId === productId).reduce((s, o) => s + o.quantity, 0);
    for (const it of items) {
      const p = products.find((x) => x.id === it.productId)!;
      const available = availableOf(p, p.stockLevels.reduce((s, l) => s + l.quantityOnHand, 0), p.stockLevels.reduce((s, l) => s + l.quantityReserved, 0)) + mine(p.id);
      if (available < it.quantity) {
        return { ok: false, error: { type: "conflict", message: `Only ${available} in stock for ${p.name}` } };
      }
    }

    // Prices: the list price unless the screen sends a changed one (bounded + reasoned). The screen sends a line's
    // earlier changed price again with its reason, so a later edit never quietly puts the list price back.
    const newLines: { productId: string; productName: string; sku: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number; priceOverridden: boolean; priceOverrideReason: string | null; catalogUnitPriceMinor: number | null }[] = [];
    for (const it of items) {
      const p = products.find((x) => x.id === it.productId)!;
      let price;
      try {
        price = resolveLinePrice({ catalogUnitPriceMinor: p.priceMinor, override: it.unitPriceMinorOverride, reason: it.priceOverrideReason });
      } catch (e) {
        return { ok: false, error: { type: "validation", errors: [`${p.name}: ${e instanceof Error ? e.message : "Invalid price"}`] } };
      }
      newLines.push({
        productId: p.id, productName: p.name, sku: p.sku, unitPriceMinor: price.unitPriceMinor, quantity: it.quantity,
        lineTotalMinor: price.unitPriceMinor * it.quantity, priceOverridden: price.overridden, priceOverrideReason: price.reason,
        catalogUnitPriceMinor: price.overridden ? price.catalogUnitPriceMinor : null,
      });
    }
    // Totals (no delivery fee change: keep the order's original decision; recompute lines only)
    const totals = computeOrderTotals({ lines: newLines.map((l) => ({ unitPriceMinor: l.unitPriceMinor, quantity: l.quantity })) });
    const totalMinor = Math.max(0, totals.totalMinor + order.deliveryFeeMinor - order.discountMinor);
    const actor = actorId ?? "admin";
    const overriddenAt = new Date();

    try {
      await prisma.$transaction(async (tx) => {
        if (reserved) {
          // Online / hub order: the units are still on the shelf, only the hold moves to the new lines.
          await moveOrderReservation(tx, { id: orderId, storeId }, newLines, actor);
        } else {
          // Stock-delta: restore old, deduct new (net effect = difference) + ledger.
          // Rice Ops M1: the old lines go back to the location they came from, the new
          // lines are taken from that same location, and the ledger names the editor.
          const firstTake = await tx.stockMovement.findFirst({
            where: { storeId, orderId, delta: { lt: 0 }, variantId: null, warehouseId: { not: null } },
            orderBy: { createdAt: "asc" },
            select: { warehouseId: true },
          });
          await restoreStock(tx, storeId, oldItems.map((oi) => ({ productId: oi.productId ?? "", quantity: oi.quantity })), { type: "RELEASE", orderId, createdBy: actor, documentType: "ORDER_EDIT", documentId: orderId });
          for (const nl of newLines) {
            await deductStock(tx, storeId, [{ productId: nl.productId, quantity: nl.quantity }], { type: "CONSUME", orderId, createdBy: actor, warehouseId: firstTake?.warehouseId ?? null, documentType: "ORDER_EDIT", documentId: orderId });
          }
        }
        await tx.orderItem.deleteMany({ where: { orderId } });
        await tx.orderItem.createMany({
          data: newLines.map((l) => ({
            orderId, storeId, productId: l.productId, productName: l.productName, sku: l.sku,
            unitPriceMinor: l.unitPriceMinor, quantity: l.quantity, lineTotalMinor: l.lineTotalMinor,
            priceOverridden: l.priceOverridden,
            priceOverrideReason: l.priceOverrideReason,
            priceOverriddenById: l.priceOverridden ? actorId : null,
            priceOverriddenAt: l.priceOverridden ? overriddenAt : null,
            catalogUnitPriceMinor: l.catalogUnitPriceMinor,
          })),
        });
        await tx.order.update({
          where: { id: orderId },
          data: {
            subtotalMinor: totals.subtotalMinor,
            totalMinor,
            // M4: re-freeze the VAT breakdown — the edited basket may carry different exemptions.
            ...(await taxColumnsFor(storeId, newLines.map((l) => ({ productId: l.productId, lineTotalMinor: l.lineTotalMinor })), {
              discountMinor: order.discountMinor,
              deliveryFeeMinor: order.deliveryFeeMinor,
            })),
            snapshot: { lines: newLines, source: order.source, paymentMethod: order.paymentMethod } as object,
          },
        });
        await tx.orderStatusHistory.create({
          data: { orderId, storeId, fromStatus: order.status, toStatus: order.status, reason: "items edited", actorType: "admin", actorId },
        });
      });
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        const name = products.find((p) => p.id === e.productId)?.name ?? "an item";
        return { ok: false, error: { type: "conflict", message: `Not enough stock for ${name}` } };
      }
      throw e;
    }
    await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("orders", storeId));
    return { ok: true, value: { id: orderId, status: order.status, totalMinor } };
  }

  /** W1: one-tap advance CONFIRMED/PREPARING/READY → OUT_FOR_DELIVERY (delivery-type only). */
  async sendForDelivery(storeId: string, orderId: string): Promise<AdminResult<{ id: string; status: string }>> {
    const order = await prisma.order.findFirst({ where: { storeId, id: orderId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (!this.isDeliveryOrder(order)) {
      return { ok: false, error: { type: "conflict", message: "Only delivery-type orders can be sent for delivery" } };
    }
    if (!["CONFIRMED", "PREPARING", "READY"].includes(order.status)) {
      return { ok: false, error: { type: "conflict", message: `Cannot send an order in ${order.status} for delivery` } };
    }
    const hops: OrderState[] = order.status === "CONFIRMED"
      ? ["PREPARING", "READY", "OUT_FOR_DELIVERY"]
      : order.status === "PREPARING" ? ["READY", "OUT_FOR_DELIVERY"] : ["OUT_FOR_DELIVERY"];

    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { status: "OUT_FOR_DELIVERY", paymentStatus: order.paymentStatus } });
      for (let i = 0; i < hops.length; i++) {
        await tx.orderStatusHistory.create({
          data: { orderId, storeId, fromStatus: i === 0 ? order.status : (hops[i - 1] as OrderState), toStatus: hops[i] as OrderState, reason: "send-for-delivery (one-tap)", actorType: "admin", actorId: null },
        });
      }
    });
    await cacheBust(cacheKey("orders", storeId));
    return { ok: true, value: { id: orderId, status: "OUT_FOR_DELIVERY" } };
  }

  /** W1: complete a pickup/POS order directly from RECEIVED/CONFIRMED. */
  async completeNow(storeId: string, orderId: string): Promise<AdminResult<{ id: string; status: string }>> {
    const order = await prisma.order.findFirst({ where: { storeId, id: orderId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (this.isDeliveryOrder(order)) {
      return { ok: false, error: { type: "conflict", message: "Delivery orders must go through the delivery pipeline" } };
    }
    if (!["RECEIVED", "CONFIRMED", "READY"].includes(order.status)) {
      return { ok: false, error: { type: "conflict", message: `Cannot complete an order in ${order.status}` } };
    }
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { status: "COMPLETED", paymentStatus: "COLLECTED" } });
      await tx.orderStatusHistory.create({
        data: { orderId, storeId, fromStatus: order.status, toStatus: "COMPLETED", reason: "move-to-completed (pickup)", actorType: "admin", actorId: null },
      });
      // Handed over at the counter: the checkout reservation is now consumed.
      await settleForStatus(tx, { id: orderId, storeId }, "COMPLETED");
    });
    await cacheBust(cacheKey("orders", storeId));
    return { ok: true, value: { id: orderId, status: "COMPLETED" } };
  }
}