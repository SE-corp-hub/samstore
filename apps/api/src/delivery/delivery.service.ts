// DELIVERY role (courier) — decision #4: sees ALL OUT_FOR_DELIVERY orders for the store
// (no per-order assignment). Marks DELIVERED / FAILED_DELIVERY (+ reason). Tenant-scoped.

import { prisma } from "../persistence/prisma-repositories.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import type { ApiError } from "@sam-store/contracts";

export type DeliveryResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const DELIVERY_SERVICE = Symbol("DELIVERY_SERVICE");

export class DeliveryService {
  /** Active deliveries: all OUT_FOR_DELIVERY orders of the store. */
  async myDeliveries(storeId: string) {
    return prisma.order.findMany({
      where: { storeId, status: "OUT_FOR_DELIVERY" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        orderNumber: true,
        customerName: true,
        customerPhone: true,
        deliveryAddressLine1: true,
        deliveryAddressLine2: true,
        landmark: true,
        deliverySchedule: true,
        notes: true,
        totalMinor: true,
        paymentMethod: true,
        createdAt: true,
        items: { select: { productName: true, quantity: true, lineTotalMinor: true } },
      },
    });
  }

  /** U7 — recently completed deliveries (recall for the courier). */
  async recentDeliveries(storeId: string) {
    return prisma.order.findMany({
      where: { storeId, status: { in: ["DELIVERED", "FAILED_DELIVERY"] } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        customerName: true,
        customerPhone: true,
        deliveryAddressLine1: true,
        totalMinor: true,
        createdAt: true,
      },
    });
  }

  /** Mark DELIVERED (collects COD) or FAILED_DELIVERY (+ reason). OUT_FOR_DELIVERY only. */
  async markStatus(
    storeId: string,
    orderId: string,
    toStatus: "DELIVERED" | "FAILED_DELIVERY",
    reason?: string,
  ): Promise<DeliveryResult<{ id: string; status: string; paymentStatus: string }>> {
    const order = await prisma.order.findFirst({ where: { storeId, id: orderId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.status !== "OUT_FOR_DELIVERY") {
      return { ok: false, error: { type: "conflict", message: `Cannot update an order in ${order.status}` } };
    }
    const paymentStatus = toStatus === "DELIVERED" ? "COLLECTED" : order.paymentStatus;
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: toStatus, paymentStatus },
      });
      await tx.orderStatusHistory.create({
        data: { orderId, storeId, fromStatus: "OUT_FOR_DELIVERY", toStatus, reason: reason?.trim() ?? null, actorType: "delivery" },
      });
    });
    // Award loyalty points when a delivery is completed (same rule as admin transition).
    if (toStatus === "DELIVERED") {
      await new LoyaltyService().earnForDeliveredOrder(orderId);
    }
    return { ok: true, value: { id: orderId, status: toStatus, paymentStatus } };
  }

  /** Retry a failed delivery: move FAILED_DELIVERY back to OUT_FOR_DELIVERY. */
  async retryDelivery(
    storeId: string,
    orderId: string,
  ): Promise<DeliveryResult<{ id: string; status: string }>> {
    const order = await prisma.order.findFirst({ where: { storeId, id: orderId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.status !== "FAILED_DELIVERY") {
      return { ok: false, error: { type: "conflict", message: `Cannot retry an order in ${order.status}` } };
    }
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "OUT_FOR_DELIVERY" },
      });
      await tx.orderStatusHistory.create({
        data: { orderId, storeId, fromStatus: "FAILED_DELIVERY", toStatus: "OUT_FOR_DELIVERY", reason: "Retry dispatch", actorType: "delivery" },
      });
    });
    return { ok: true, value: { id: orderId, status: "OUT_FOR_DELIVERY" } };
  }

  /** Cancel a post-dispatch order. OUT_FOR_DELIVERY only; must be within the cancellation window. */
  async cancelPostDispatch(
    storeId: string,
    orderId: string,
    reason?: string,
  ): Promise<DeliveryResult<{ id: string; status: string }>> {
    const order = await prisma.order.findFirst({ where: { storeId, id: orderId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.status !== "OUT_FOR_DELIVERY") {
      return { ok: false, error: { type: "conflict", message: `Cannot cancel an order in ${order.status}` } };
    }
    const minutesSinceDispatch = (Date.now() - order.createdAt.getTime()) / 60_000;
    if (minutesSinceDispatch > 30) {
      return { ok: false, error: { type: "conflict", message: `Cancellation window expired (${Math.floor(minutesSinceDispatch)}m > 30m)` } };
    }
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELLED" },
      });
      await tx.orderStatusHistory.create({
        data: { orderId, storeId, fromStatus: "OUT_FOR_DELIVERY", toStatus: "CANCELLED", reason: reason?.trim() ?? null, actorType: "delivery" },
      });
    });
    return { ok: true, value: { id: orderId, status: "CANCELLED" } };
  }
}