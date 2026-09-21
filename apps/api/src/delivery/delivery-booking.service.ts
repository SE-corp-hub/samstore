// P5b: courier bookings + delivery events + COD remittance ledger.
// A booking is created via the courier adapter (mock/PENDING_CREDENTIALS), status
// advances through append-only DeliveryEvent rows, and COD cash collected by the
// courier is tracked against the remittance ledger (never more than codMinor).

import { prisma } from "../persistence/prisma-repositories.js";
import { getCourier } from "./couriers.js";
import type { ApiError } from "@sam-store/contracts";

export type BookingResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const COURIER_STATUSES = ["created", "accepted", "picked_up", "delivered", "failed", "cancelled"] as const;

export class DeliveryBookingService {
  /** Create a courier booking for an order (or owner-run delivery). */
  async createBooking(
    storeId: string,
    orderId: string,
    courier: string,
    opts: { codMinor?: number; pickupNote?: string } = {},
  ): Promise<BookingResult<{ id: string; trackingNumber: string | null; remoteId: string | null; status: string }>> {
    const order = await prisma.order.findFirst({ where: { id: orderId, storeId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    const adapter = getCourier(courier);
    const booking = await adapter.createBooking({
      referenceId: order.id,
      amountMinor: order.totalMinor,
      currency: order.currencyCode,
      pickupNote: opts.pickupNote,
      dropoffAddress: order.deliveryAddressLine1,
    });
    const cod = Math.max(0, opts.codMinor ?? 0);
    if (cod > order.totalMinor) {
      return { ok: false, error: { type: "validation", errors: ["codMinor cannot exceed the order total"] } };
    }
    const created = await prisma.deliveryBooking.create({
      data: {
        storeId,
        orderId,
        courier,
        trackingNumber: booking.trackingNumber,
        remoteId: booking.remoteId,
        codMinor: cod,
        status: "created",
        events: { create: { storeId, status: "created", note: `Booked with ${courier}` } },
      },
    });
    return { ok: true, value: { id: created.id, trackingNumber: created.trackingNumber, remoteId: created.remoteId, status: created.status } };
  }

  /** Advance a booking's status (append-only event; delivered/failed/cancelled are terminal). */
  async addEvent(storeId: string, bookingId: string, status: string, note?: string): Promise<BookingResult<{ id: string; status: string }>> {
    if (!COURIER_STATUSES.includes(status as (typeof COURIER_STATUSES)[number])) {
      return { ok: false, error: { type: "validation", errors: [`status must be one of ${COURIER_STATUSES.join(", ")}`] } };
    }
    const booking = await prisma.deliveryBooking.findFirst({ where: { id: bookingId, storeId } });
    if (!booking) return { ok: false, error: { type: "not_found", message: "Booking not found" } };
    if (["delivered", "failed", "cancelled"].includes(booking.status)) {
      return { ok: false, error: { type: "conflict", message: `Booking is already ${booking.status}` } };
    }
    await prisma.$transaction(async (tx) => {
      await tx.deliveryBooking.update({ where: { id: bookingId }, data: { status } });
      await tx.deliveryEvent.create({ data: { storeId, bookingId, status, note: note?.trim() || null } });
    });
    return { ok: true, value: { id: bookingId, status } };
  }

  /** Record a COD remittance from the courier (never more than the outstanding cod). */
  async remit(storeId: string, bookingId: string, amountMinor: number, actorId: string, note?: string): Promise<BookingResult<{ id: string; remittedMinor: number }>> {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      return { ok: false, error: { type: "validation", errors: ["amountMinor must be a positive integer"] } };
    }
    const booking = await prisma.deliveryBooking.findFirst({ where: { id: bookingId, storeId } });
    if (!booking) return { ok: false, error: { type: "not_found", message: "Booking not found" } };
    if (booking.remittedMinor + amountMinor > booking.codMinor) {
      return { ok: false, error: { type: "conflict", message: `Remittance exceeds the outstanding COD (${((booking.codMinor - booking.remittedMinor) / 100).toFixed(2)} remaining)` } };
    }
    await prisma.$transaction(async (tx) => {
      await tx.courierRemittance.create({ data: { storeId, bookingId, amountMinor, note: note?.trim() || null, recordedBy: actorId } });
      await tx.deliveryBooking.update({ where: { id: bookingId }, data: { remittedMinor: { increment: amountMinor } } });
    });
    return { ok: true, value: { id: bookingId, remittedMinor: booking.remittedMinor + amountMinor } };
  }

  /** Bookings for a store (newest first) with events + remittances. */
  async list(storeId: string, orderId?: string) {
    return prisma.deliveryBooking.findMany({
      where: { storeId, ...(orderId ? { orderId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        events: { orderBy: { createdAt: "asc" } },
        remittances: { orderBy: { createdAt: "asc" } },
        order: { select: { orderNumber: true, totalMinor: true, customerName: true, deliveryAddressLine1: true } },
      },
    });
  }
}