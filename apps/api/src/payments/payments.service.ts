// Payments, receipts, voids & refunds.
// - Payments attach to orders (cash / credit / cod_collected), with change for cash.
// - Receipt view: deterministic printable layout (browser print) — store, order, line items,
//   totals, VAT display-only label (decision #2), payment info.
// - Void (same-day, unfulfilled POS sale): reverses the sale, restores stock, order → CANCELLED.
// - Refund: negative Payment + order → CANCELLED with reason (audited).

import { lockOrder, OrderChanged } from "../domain/order-lock.js";
import type { Prisma } from "@prisma/client";
import { orderWall } from "../auth/wall.js";
import { manilaDate } from "../domain/reports.js";
import { closedTodayRefusal } from "../day/day-gate.js";
import { reverseSaleCharges } from "../payable/charges.js";
import { prisma } from "../persistence/prisma-repositories.js";
import { randomId } from "../persistence/repositories.js";
import { restoreStock } from "../domain/movements.js";
import { settleOrderReservations } from "../domain/stock-settlement.js";
import { RegisterService } from "../registers/register.service.js";
import { LoyaltyService } from "../loyalty/loyalty.service.js";
import { getGateway } from "./gateway.js";
import type { ApiError } from "@sam-store/contracts";

export type PaymentResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const PAYMENTS_SERVICE = Symbol("PAYMENTS_SERVICE");

export class PaymentsService {
  /** N1: drawer attribution for the non-POS cash paths (refunds, admin payments). */
  private readonly registers = new RegisterService();
  /** P3h: reversals — points earned for a cancelled order are clawed back. */
  private readonly loyalty = new LoyaltyService();

  /** Record a payment against an order. */
  async recordPayment(input: {
    orderId: string;
    storeId: string;
    method: "cash" | "credit" | "cod_collected";
    amountMinor: number;
    changeMinor?: number;
    note?: string;
    createdBy?: string;
  }): Promise<PaymentResult<{ id: string }>> {
    const order = await prisma.order.findFirst({ where: { id: input.orderId, storeId: input.storeId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      return { ok: false, error: { type: "validation", errors: ["amountMinor must be a positive integer"] } };
    }
    // N1: a cash payment taken while a drawer shift is open belongs to that shift;
    // without an open shift it still records (off-counter collection) with no session.
    const registerSessionId = input.method === "cash" ? await this.registers.attachOpenSession(input.storeId) : null;
    const payment = await prisma.payment.create({
      data: {
        orderId: input.orderId,
        storeId: input.storeId,
        method: input.method,
        amountMinor: input.amountMinor,
        changeMinor: input.changeMinor ?? 0,
        note: input.note?.trim() ?? null,
        createdBy: input.createdBy ?? null,
        registerSessionId,
      },
    });
    return { ok: true, value: { id: payment.id } };
  }

  // ─────────────────────────────── P4: gateway + payment links ───────────────────────────────

  /** Create a gateway-hosted checkout (payment link) for an order. No card data stored. */
  async createGatewayPayment(
    orderId: string,
    storeId: string,
    gatewayName: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<PaymentResult<{ paymentId: string; checkoutUrl: string; checkoutSessionId: string }>> {
    const order = await prisma.order.findFirst({ where: { id: orderId, storeId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.paymentStatus === "COLLECTED" || order.paymentStatus === "REFUNDED" || order.paymentStatus === "REVIEWED") {
      return { ok: false, error: { type: "conflict", message: "Order is already settled" } };
    }
    const gateway = getGateway(gatewayName);
    const idempotencyKey = opts.idempotencyKey ?? `pay-${randomId()}`;
    const session = await gateway.createCheckoutSession({
      amountMinor: order.totalMinor,
      currency: order.currencyCode,
      idempotencyKey,
      referenceId: order.id,
      description: `Order ${order.orderNumber}`,
    });
    const payment = await prisma.payment.create({
      data: {
        orderId,
        storeId,
        method: gatewayName,
        amountMinor: order.totalMinor,
        idempotencyKey,
        gateway: gatewayName,
        checkoutSessionId: session.checkoutSessionId,
        checkoutUrl: session.checkoutUrl,
        status: "pending",
        type: "payment",
      },
    });
    return { ok: true, value: { paymentId: payment.id, checkoutUrl: session.checkoutUrl, checkoutSessionId: session.checkoutSessionId } };
  }

  /** Process a gateway webhook — verified, parsed, IDEMPOTENT (a settled event is a no-op). */
  async handleGatewayWebhook(
    gatewayName: string,
    rawBody: string,
    signature: string | undefined,
    payload: unknown,
  ): Promise<PaymentResult<{ processed: boolean; paymentId?: string }>> {
    const gateway = getGateway(gatewayName);
    if (!gateway.verifyWebhookSignature(rawBody, signature)) {
      return { ok: false, error: { type: "unauthorized", message: "Invalid webhook signature" } };
    }
    const event = gateway.parseWebhookEvent(payload);
    if (!event) return { ok: false, error: { type: "validation", errors: ["Unparseable webhook payload"] } };

    const payment = await prisma.payment.findFirst({ where: { orderId: event.referenceId, gateway: gatewayName } });
    if (!payment) return { ok: false, error: { type: "not_found", message: "Payment session not found" } };
    const target = event.paid ? "paid" : "failed";
    if (payment.status === target) {
      return { ok: true, value: { processed: false, paymentId: payment.id } }; // idempotent replay
    }
    const order = await prisma.order.findUnique({ where: { id: event.referenceId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: target } });
      const to = event.paid ? "RECEIVED" : "FAILED";
      await tx.order.update({ where: { id: order.id }, data: { paymentStatus: to } });
      await tx.paymentStatusHistory.create({
        data: {
          storeId: order.storeId,
          orderId: order.id,
          paymentId: payment.id,
          fromStatus: order.paymentStatus,
          toStatus: to,
          reason: event.eventType,
          actorType: "gateway",
          actorId: gatewayName,
        },
      });
    });
    return { ok: true, value: { processed: true, paymentId: payment.id } };
  }

  /** Mark a RECEIVED payment as reviewed by the operator (bank-transfer/gateway proof). */
  async markPaymentReviewed(orderId: string, storeId: string, actorId: string): Promise<PaymentResult<{ id: string; status: string }>> {
    const order = await prisma.order.findFirst({ where: { id: orderId, storeId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.paymentStatus !== "RECEIVED") {
      return { ok: false, error: { type: "conflict", message: "Only received payments can be reviewed" } };
    }
    await prisma.$transaction(async (tx) => {
      // A delivered order whose GCash is confirmed afterwards is simply paid.
      await tx.order.update({ where: { id: orderId }, data: { paymentStatus: order.status === "DELIVERED" || order.status === "COMPLETED" ? "COLLECTED" : "REVIEWED" } });
      await tx.paymentStatusHistory.create({
        data: { storeId, orderId, paymentId: null, fromStatus: "RECEIVED", toStatus: "REVIEWED", reason: null, actorType: "admin", actorId },
      });
    });
    return { ok: true, value: { id: orderId, status: "REVIEWED" } };
  }

  /** Payment status history for an order (newest first). */
  async statusHistoryFor(orderId: string, storeId: string) {
    return prisma.paymentStatusHistory.findMany({
      where: { orderId, storeId },
      orderBy: { createdAt: "desc" },
    });
  }

  /** P4b: review queue — orders awaiting operator review of a bank-transfer proof (RECEIVED). */
  async reviewQueue(storeId: string) {
    const orders = await prisma.order.findMany({
      // Open orders only: a cancelled order has nothing left to confirm. Oldest first, the one waiting longest.
      where: { storeId, paymentStatus: "RECEIVED", status: { notIn: ["CANCELLED"] }, AND: [orderWall()] },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: {
        id: true,
        orderNumber: true,
        totalMinor: true,
        customerName: true,
        paymentMethod: true,
        createdAt: true,
        status: true,
        deliveryType: true,
        source: true,
        sourcePage: true,
        externalRef: true,
        customerPhone: true,
        payments: { where: { type: "payment" }, orderBy: { receivedAt: "desc" }, take: 1 },
      },
    });
    return orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      totalMinor: o.totalMinor,
      customerName: o.customerName,
      paymentMethod: o.paymentMethod,
      createdAt: o.createdAt.toISOString(),
      status: o.status,
      deliveryType: o.deliveryType,
      source: o.source,
      sourcePage: o.sourcePage,
      externalRef: o.externalRef,
      customerPhone: o.customerPhone,
      payment: o.payments[0],
    }));
  }

  /** P4b: submit a bank-transfer proof image (base64 data-URL) for an order. Validated,
   *  stored on the bank-transfer Payment row, order → RECEIVED (from PENDING) with history. */
  async submitBankProof(
    orderId: string,
    storeId: string,
    actorId: string,
    proofDataUrl: string,
  ): Promise<PaymentResult<{ id: string; status: string }>> {
    const order = await prisma.order.findFirst({ where: { id: orderId, storeId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.paymentStatus !== "PENDING") {
      return { ok: false, error: { type: "conflict", message: "Only pending payments can accept a proof" } };
    }

    // Validate: must be a base64 data-URL image (png/jpeg), ≤ 2 MB decoded.
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(proofDataUrl?.trim() ?? "");
    if (!match) {
      return { ok: false, error: { type: "validation", errors: ["Proof must be a PNG or JPEG image (base64 data-URL)"] } };
    }
    const [, mime, b64] = match;
    let bytes = 0;
    try {
      bytes = Buffer.from(b64 ?? "", "base64").length;
    } catch {
      return { ok: false, error: { type: "validation", errors: ["Proof image could not be decoded"] } };
    }
    if (bytes < 1 || bytes > 2 * 1024 * 1024) {
      return { ok: false, error: { type: "validation", errors: ["Proof image must be between 1 byte and 2 MB"] } };
    }

    await prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { orderId, storeId, type: "payment" },
        data: { proofData: proofDataUrl, proofMime: mime },
      });
      await tx.order.update({ where: { id: orderId }, data: { paymentStatus: "RECEIVED" } });
      await tx.paymentStatusHistory.create({
        data: { storeId, orderId, paymentId: null, fromStatus: "PENDING", toStatus: "RECEIVED", reason: "bank-transfer proof submitted", actorType: "admin", actorId },
      });
    });
    return { ok: true, value: { id: orderId, status: "RECEIVED" } };
  }

  /** Receipt view for an order (deterministic). */
  async receipt(orderId: string, storeId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: {
        items: true,
        payments: { orderBy: { receivedAt: "asc" } },
        store: { select: { name: true, slug: true, currencyCode: true } },
        // Step 9: the receipt carries the name and text of the store that made the sale.
        sellingLocation: { select: { id: true, name: true, receiptName: true, receiptHeader: true, receiptFooter: true, receiptContact: true } },
        storeCustomer: { include: { customer: { select: { name: true, phone: true } } } },
      },
    });
    if (!order) return null;
    // M3: the printed slip must show WHAT settled the order — method labels, what was handed
    // over, the change, the reference, and anything still outstanding.
    const methods = await prisma.paymentMethod.findMany({ where: { storeId }, select: { code: true, label: true, kind: true } });
    // M4: the owner's VAT display preferences (read after `methods` — sequential reads only).
    const vatSettings = await prisma.storeSettings.findUnique({
      where: { storeId },
      select: { vatEnabled: true, vatRateBp: true, pricesIncludeVat: true, vatShowOnReceipt: true, showVatLabel: true, tin: true },
    });
    const labelOf = new Map(methods.map((m) => [m.code, m.label]));
    const kindOf = new Map(methods.map((m) => [m.code, m.kind as string]));
    const paidMinor = order.payments.filter((p) => p.type !== "void" && p.amountMinor > 0).reduce((s, p) => s + p.amountMinor, 0);
    const refundedMinor = order.payments.filter((p) => p.type === "refund").reduce((s, p) => s + -p.amountMinor, 0);
    const changeMinor = order.payments.reduce((s, p) => s + p.changeMinor, 0);
    const net = paidMinor - refundedMinor;
    const outstandingMinor = Math.max(0, order.totalMinor - net);
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      source: order.source,
      storeName: order.sellingLocation?.receiptName || order.store.name,
      // The selling store's own receipt text (null = the business's, from Settings).
      locationId: order.sellingLocation?.id ?? null,
      receiptHeader: order.sellingLocation?.receiptHeader ?? null,
      receiptFooter: order.sellingLocation?.receiptFooter ?? null,
      receiptContact: order.sellingLocation?.receiptContact ?? null,
      currencyCode: order.currencyCode,
      subtotalMinor: order.subtotalMinor,
      deliveryFeeMinor: order.deliveryFeeMinor,
      discountMinor: order.discountMinor,
      totalMinor: order.totalMinor,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      createdAt: order.createdAt,
      items: order.items.map((i) => ({
        productName: i.productName,
        sku: i.sku,
        unitPriceMinor: i.unitPriceMinor,
        quantity: i.quantity,
        lineTotalMinor: i.lineTotalMinor,
        // Counter price override: the slip can show that staff changed this price.
        priceOverridden: i.priceOverridden,
        priceOverrideReason: i.priceOverrideReason,
        catalogUnitPriceMinor: i.catalogUnitPriceMinor,
      })),
      payments: order.payments.map((p) => ({
        id: p.id,
        method: p.method,
        methodLabel: labelOf.get(p.method) ?? p.method,
        kind: kindOf.get(p.method) ?? "OTHER",
        amountMinor: p.amountMinor,
        tenderedMinor: p.tenderedMinor,
        changeMinor: p.changeMinor,
        reference: p.reference,
        type: p.type,
        note: p.note,
        receivedAt: p.receivedAt,
      })),
      tenders: {
        paidMinor,
        refundedMinor,
        changeMinor,
        outstandingMinor,
        settlement: order.totalMinor === 0 ? "PAID" : net <= 0 ? "UNPAID" : outstandingMinor > 0 ? "PARTIAL" : "PAID",
      },
      // M4: the VAT breakdown frozen at checkout + the owner's slip preferences. `showOnReceipt`
      // is display-only — hiding the lines never changes a total.
      vat: {
        enabled: vatSettings?.vatEnabled ?? true,
        rateBp: order.vatRateBp,
        pricesIncludeVat: vatSettings?.pricesIncludeVat ?? true,
        vatableMinor: order.vatableMinor,
        vatMinor: order.vatMinor,
        vatExemptMinor: order.vatExemptMinor,
        showOnReceipt: (vatSettings?.vatShowOnReceipt ?? true) && (vatSettings?.showVatLabel ?? true),
        tin: vatSettings?.tin ?? null,
      },
    };
  }

  /**
   * What a sale that is taken back (void or refund) gives back besides its payments:
   *   - credit: what this sale put on the customer's debt comes off again; anything the customer
   *     already paid of it is cash given back (returned amount);
   *   - cash the owner kept: the drawer never held it, so the cash given back is not taken from the drawer.
   */
  private async undoCreditAndOwnerCash(
    tx: Prisma.TransactionClient,
    order: { id: string; storeId: string; orderNumber: string; storeCustomerId: string | null; sellingLocationId: string | null },
    actorId: string, why: string, registerSessionId: string | null,
  ): Promise<void> {
    const { id: orderId, storeId } = order;
    if (order.storeCustomerId) {
      // Everything this sale wrote on the customer's credit: the sale itself, less returns already taken off.
      const owed = (await tx.creditEntry.aggregate({ where: { storeId, storeCustomerId: order.storeCustomerId, orderId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
      if (owed > 0) {
        const sc = await tx.storeCustomer.findUniqueOrThrow({ where: { id: order.storeCustomerId }, select: { creditBalanceMinor: true } });
        const reduce = Math.min(owed, Math.max(0, sc.creditBalanceMinor));
        if (reduce > 0) {
          await tx.storeCustomer.update({ where: { id: order.storeCustomerId }, data: { creditBalanceMinor: { decrement: reduce } } });
          await tx.creditEntry.create({ data: { storeId, storeCustomerId: order.storeCustomerId, orderId, type: "adjustment", amountMinor: -reduce, note: `${why} (${order.orderNumber})`.slice(0, 200), createdBy: actorId } });
        }
        // The customer already paid some of this sale's credit: that money goes back as cash.
        if (owed > reduce) {
          await tx.payment.create({ data: { orderId, storeId, method: "cash", amountMinor: -(owed - reduce), note: `REFUND: credit already paid (${order.orderNumber})`.slice(0, 200), type: "refund", createdBy: actorId, registerSessionId, locationId: order.sellingLocationId } });
        }
      }
    }
    // The owner kept this sale's cash, so the owner gives it back: today's drawer is not short by it.
    const kept = (await tx.cashHandover.aggregate({ where: { storeId, orderId, voidedAt: null }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
    const first = kept > 0 ? await tx.cashHandover.findFirst({ where: { storeId, orderId, voidedAt: null }, orderBy: { createdAt: "asc" }, select: { locationId: true, handedById: true } }) : null;
    if (first) {
      await tx.cashHandover.create({ data: { storeId, locationId: first.locationId, businessDate: manilaDate(new Date()), amountMinor: -kept, note: `Owner's sale ${order.orderNumber} taken back`, handedById: actorId, receivedById: first.handedById, orderId } });
    }
  }

  /** Put back on the shelf what this order really took off it (never more than the stock book shows). */
  private async restoreTaken(tx: Prisma.TransactionClient, storeId: string, orderId: string, items: { productId: string | null; quantity: number }[], type: string, actorId: string): Promise<void> {
    const moved = await tx.stockMovement.groupBy({ by: ["productId"], where: { storeId, orderId, type: { notIn: ["RESERVE", "RELEASE_RESERVATION"] } }, _sum: { delta: true } });
    const taken = new Map(moved.map((m) => [m.productId, -(m._sum.delta ?? 0)]));
    // Rice the customer already brought back with Returns (good went back on the shelf, damaged was put
    // aside) is no longer out with the customer: refunding the whole sale must not put it back again.
    const returned = await tx.stockReturn.groupBy({ by: ["productId"], where: { storeId, orderId }, _sum: { quantity: true } });
    for (const r of returned) taken.set(r.productId, (taken.get(r.productId) ?? 0) - (r._sum.quantity ?? 0));
    const lines: { productId: string; quantity: number }[] = [];
    for (const it of items) {
      if (!it.productId) continue;
      const left = taken.get(it.productId) ?? 0;
      const quantity = Math.min(it.quantity, left);
      if (quantity <= 0) continue;
      taken.set(it.productId, left - quantity);
      lines.push({ productId: it.productId, quantity });
    }
    await restoreStock(tx, storeId, lines, { type, orderId, createdBy: actorId });
  }

  /** Void an unfulfilled POS sale (same-day): restores stock, order → CANCELLED. */
  async voidOrder(orderId: string, storeId: string, actorId: string, reason?: string): Promise<PaymentResult<{ id: string; status: string }>> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: { items: { select: { productId: true, quantity: true } } },
    });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.paymentStatus === "COLLECTED") return { ok: false, error: { type: "conflict", message: "Collected sales must be refunded, not voided" } };
    if (order.status === "CANCELLED") return { ok: false, error: { type: "conflict", message: "Order is already cancelled" } };

    try {
      await prisma.$transaction(async (tx) => {
        // Tapped twice, or two people at once: the second waits here, then sees the first one's void.
        const locked = await lockOrder(tx, storeId, orderId);
        if (!locked || locked.status === "CANCELLED") throw new OrderChanged("Order is already cancelled");
        if (locked.paymentStatus === "COLLECTED") throw new OrderChanged("Collected sales must be refunded, not voided");
        // Stock is source-aware: an ONLINE order still holds a checkout reservation,
        // so a void releases it (the units never left the shelf and on-hand must not
        // grow). A POS/pre-order sale already consumed on-hand at sale time, so it is
        // restored instead. `no-reservation` is the signal for the POS branch.
        const settlement = await settleOrderReservations(tx, { id: orderId, storeId }, "RELEASED");
        if (settlement.outcome === "no-reservation") {
          // Never more than this sale really took off the shelf (as the refund does).
          await this.restoreTaken(tx, storeId, orderId, order.items, "VOID_RESTORE", actorId);
        }
        await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED", paymentStatus: "CANCELLED_REFUND" } });
        await reverseSaleCharges(tx, storeId, orderId, actorId, reason?.trim() || "sale voided");
        const registerSessionId = await this.registers.attachOpenSession(storeId);
        await tx.payment.create({
          data: { orderId, storeId, method: "cash", amountMinor: 0, note: `VOID: ${reason?.trim() ?? "same-day void"}`.slice(0, 200), type: "void", createdBy: actorId, registerSessionId },
        });
        // A credit sale that is cancelled is no longer owed (the cash book already gives back a voided sale's cash).
        await this.undoCreditAndOwnerCash(tx, order, actorId, "Sale cancelled", registerSessionId);
        await tx.orderStatusHistory.create({
          data: { orderId, storeId, fromStatus: order.status, toStatus: "CANCELLED", reason: reason?.trim() ?? null, actorType: "pos_void", actorId },
        });
        await tx.paymentStatusHistory.create({
          data: { storeId, orderId, paymentId: null, fromStatus: order.paymentStatus, toStatus: "CANCELLED_REFUND", reason: `void: ${reason?.trim() ?? "same-day void"}`.slice(0, 200), actorType: "admin", actorId },
        });
      });
    } catch (e) {
      if (e instanceof OrderChanged) return { ok: false, error: { type: "conflict", message: e.message } };
      throw e;
    }
    // P3h: claw back points earned for this order (idempotent; no-op when none earned).
    await this.loyalty.reverseForOrder(orderId, "order voided");
    return { ok: true, value: { id: orderId, status: "CANCELLED" } };
  }

  /**
   * Refund a collected sale. A refund takes back the WHOLE sale: every payment goes back the way it
   * was paid (cash as cash, GCash as GCash, credit off the customer's debt), the rice goes back on
   * the shelf it left, and the order is CANCELLED. Rice returned in part goes through Returns.
   */
  async refundOrder(orderId: string, storeId: string, actorId: string, amountMinor?: number, reason?: string): Promise<PaymentResult<{ id: string; status: string }>> {
    const order = await prisma.order.findFirst({ where: { id: orderId, storeId }, include: { items: { select: { productId: true, quantity: true } } } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.paymentStatus !== "COLLECTED" && order.paymentStatus !== "REVIEWED") {
      return { ok: false, error: { type: "conflict", message: "Only collected or reviewed payments can be refunded" } };
    }
    if (order.status === "CANCELLED") return { ok: false, error: { type: "conflict", message: "Order is already cancelled (refunded)" } };
    if (amountMinor !== undefined && (!Number.isInteger(amountMinor) || amountMinor <= 0)) {
      return { ok: false, error: { type: "validation", errors: ["refund amount must be a positive integer"] } };
    }
    // What is still held of this sale, by the way it was paid. Credit is not money in hand: it is undone on the customer's debt.
    const payments = await prisma.payment.findMany({ where: { orderId, method: { not: "credit" } }, select: { amountMinor: true, type: true, method: true } });
    const held = new Map<string, number>();
    for (const p of payments) {
      if (p.type === "payment" && p.amountMinor > 0) held.set(p.method, (held.get(p.method) ?? 0) + p.amountMinor);
      else if (p.type === "refund") held.set(p.method, (held.get(p.method) ?? 0) - Math.abs(p.amountMinor));
    }
    const remaining = [...held.values()].reduce((s, v) => s + Math.max(0, v), 0);
    if (amountMinor !== undefined && amountMinor > remaining) {
      return { ok: false, error: { type: "conflict", message: `Refund exceeds the remaining captured amount (₱${(remaining / 100).toFixed(2)} available)` } };
    }
    if (amountMinor !== undefined && amountMinor < remaining) {
      return { ok: false, error: { type: "conflict", message: `A refund takes back the whole sale (₱${(remaining / 100).toFixed(2)}). For rice returned in part, use Returns.` } };
    }
    // Cash given back today after the store's Z-read would be in no Z-read: the owner reopens the day first.
    if ((held.get("cash") ?? 0) > 0 && order.sellingLocationId) {
      const closed = await closedTodayRefusal(prisma, storeId, order.sellingLocationId);
      if (closed) return { ok: false, error: { type: "conflict", message: closed } };
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Tapped twice, or two people at once: the second waits here, then sees the first one's refund
        // (else the cash would be given back twice).
        const locked = await lockOrder(tx, storeId, orderId);
        if (!locked || locked.status === "CANCELLED") throw new OrderChanged("Order is already cancelled (refunded)");
        // N1: the cash leaves the drawer NOW — attribute the refund to the open shift
        // so the X/Z report's expected cash accounts for it (null when off-counter).
        const registerSessionId = await this.registers.attachOpenSession(storeId);
        for (const [method, amount] of held) {
          if (amount <= 0) continue;
          await tx.payment.create({
            data: { orderId, storeId, method, amountMinor: -amount, note: `REFUND: ${reason?.trim() ?? "customer refund"}`.slice(0, 200), type: "refund", createdBy: actorId, registerSessionId, locationId: order.sellingLocationId },
          });
        }
        await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED", paymentStatus: "REFUNDED" } });
        // The sale is taken back, so is what its store owed the main store for it (and any profit share it booked).
        await reverseSaleCharges(tx, storeId, orderId, actorId, reason?.trim() || "sale refunded");
        await this.undoCreditAndOwnerCash(tx, order, actorId, "Sale refunded", registerSessionId);
        // The rice comes back. An online order refunded before it went out still only HOLDS its rice:
        // the hold is given back. Rice that already left the shelf (a counter sale, or an order that
        // was handed over) is put back on the shelf it left.
        const settlement = await settleOrderReservations(tx, { id: orderId, storeId }, "RELEASED");
        if (settlement.outcome === "no-reservation" || (settlement.outcome === "already-settled" && order.stockDisposition === "CONSUMED")) {
          await this.restoreTaken(tx, storeId, orderId, order.items, "VOID_RESTORE", actorId);
        }
        await tx.orderStatusHistory.create({
          data: { orderId, storeId, fromStatus: order.status, toStatus: "CANCELLED", reason: reason?.trim() ?? null, actorType: "pos_refund", actorId },
        });
        await tx.paymentStatusHistory.create({
          data: { storeId, orderId, paymentId: null, fromStatus: order.paymentStatus, toStatus: "REFUNDED", reason: `refund: ${reason?.trim() ?? "customer refund"}`.slice(0, 200), actorType: "admin", actorId },
        });
      });
    } catch (e) {
      if (e instanceof OrderChanged) return { ok: false, error: { type: "conflict", message: e.message } };
      throw e;
    }
    // P3h: claw back points earned for this order (idempotent; no-op when none earned).
    await this.loyalty.reverseForOrder(orderId, "order refunded");
    return { ok: true, value: { id: orderId, status: "CANCELLED" } };
  }

  /** Payment history for an order. */
  async paymentsFor(orderId: string, storeId: string) {
    const order = await prisma.order.findFirst({ where: { id: orderId, storeId }, select: { id: true } });
    if (!order) return null;
    return prisma.payment.findMany({ where: { orderId }, orderBy: { receivedAt: "asc" } });
  }
}