// Payments, receipts, voids & refunds.
// - Payments attach to orders (cash / credit / cod_collected), with change for cash.
// - Receipt view: deterministic printable layout (browser print) — store, order, line items,
//   totals, VAT display-only label (decision #2), payment info.
// - Void (same-day, unfulfilled POS sale): reverses the sale, restores stock, order → CANCELLED.
// - Refund: negative Payment + order → CANCELLED with reason (audited).

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
      await tx.order.update({ where: { id: orderId }, data: { paymentStatus: "REVIEWED" } });
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
      where: { storeId, paymentStatus: "RECEIVED" },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        orderNumber: true,
        totalMinor: true,
        customerName: true,
        paymentMethod: true,
        createdAt: true,
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
      storeName: order.store.name,
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
      items: order.items.map((i) => ({ productName: i.productName, sku: i.sku, unitPriceMinor: i.unitPriceMinor, quantity: i.quantity, lineTotalMinor: i.lineTotalMinor })),
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

  /** Void an unfulfilled POS sale (same-day): restores stock, order → CANCELLED. */
  async voidOrder(orderId: string, storeId: string, actorId: string, reason?: string): Promise<PaymentResult<{ id: string; status: string }>> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: { items: { select: { productId: true, quantity: true } } },
    });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.paymentStatus === "COLLECTED") return { ok: false, error: { type: "conflict", message: "Collected sales must be refunded, not voided" } };
    if (order.status === "CANCELLED") return { ok: false, error: { type: "conflict", message: "Order is already cancelled" } };

    await prisma.$transaction(async (tx) => {
      // Stock is source-aware: an ONLINE order still holds a checkout reservation,
      // so a void releases it (the units never left the shelf and on-hand must not
      // grow). A POS/pre-order sale already consumed on-hand at sale time, so it is
      // restored instead. `no-reservation` is the signal for the POS branch.
      const settlement = await settleOrderReservations(tx, { id: orderId, storeId }, "RELEASED");
      if (settlement.outcome === "no-reservation") {
        await restoreStock(tx, storeId, order.items.map((it) => ({ productId: it.productId ?? "", quantity: it.quantity })), { type: "VOID_RESTORE", orderId, createdBy: actorId });
      }
      await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED", paymentStatus: "CANCELLED_REFUND" } });
      await tx.payment.create({
        data: { orderId, storeId, method: "cash", amountMinor: 0, note: `VOID: ${reason?.trim() ?? "same-day void"}`.slice(0, 200), type: "void", createdBy: actorId, registerSessionId: await this.registers.attachOpenSession(storeId) },
      });
      await tx.orderStatusHistory.create({
        data: { orderId, storeId, fromStatus: order.status, toStatus: "CANCELLED", reason: reason?.trim() ?? null, actorType: "pos_void", actorId },
      });
      await tx.paymentStatusHistory.create({
        data: { storeId, orderId, paymentId: null, fromStatus: order.paymentStatus, toStatus: "CANCELLED_REFUND", reason: `void: ${reason?.trim() ?? "same-day void"}`.slice(0, 200), actorType: "admin", actorId },
      });
    });
    // P3h: claw back points earned for this order (idempotent; no-op when none earned).
    await this.loyalty.reverseForOrder(orderId, "order voided");
    return { ok: true, value: { id: orderId, status: "CANCELLED" } };
  }

  /** Refund a collected sale: negative Payment + order → CANCELLED (audited). */
  async refundOrder(orderId: string, storeId: string, actorId: string, amountMinor?: number, reason?: string): Promise<PaymentResult<{ id: string; status: string }>> {
    const order = await prisma.order.findFirst({ where: { id: orderId, storeId } });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.paymentStatus !== "COLLECTED" && order.paymentStatus !== "REVIEWED") {
      return { ok: false, error: { type: "conflict", message: "Only collected or reviewed payments can be refunded" } };
    }
    if (order.status === "CANCELLED") return { ok: false, error: { type: "conflict", message: "Order is already cancelled (refunded)" } };
    const refundAmount = amountMinor ?? order.totalMinor;
    if (!Number.isInteger(refundAmount) || refundAmount <= 0) {
      return { ok: false, error: { type: "validation", errors: ["refund amount must be a positive integer"] } };
    }
    // M7: cap the refund at the REMAINING captured amount (partial refunds allowed;
    // repeated/over refunds rejected — stock/payment can never go negative).
    const payments = await prisma.payment.findMany({ where: { orderId }, select: { amountMinor: true, type: true } });
    const captured = payments.filter((p) => p.type === "payment" && p.amountMinor > 0).reduce((s, p) => s + p.amountMinor, 0);
    const refunded = payments.filter((p) => p.type === "refund" && p.amountMinor < 0).reduce((s, p) => s + -p.amountMinor, 0);
    const remaining = captured - refunded;
    if (refundAmount > remaining) {
      return { ok: false, error: { type: "conflict", message: `Refund exceeds the remaining captured amount (₱${(remaining / 100).toFixed(2)} available)` } };
    }

    await prisma.$transaction(async (tx) => {
      // N1: the cash leaves the drawer NOW — attribute the refund to the open shift
      // so the X/Z report's expected cash accounts for it (null when off-counter).
      const registerSessionId = await this.registers.attachOpenSession(storeId);
      await tx.payment.create({
        data: { orderId, storeId, method: "cash", amountMinor: -refundAmount, note: `REFUND: ${reason?.trim() ?? "customer refund"}`.slice(0, 200), type: "refund", createdBy: actorId, registerSessionId },
      });
      await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED", paymentStatus: "REFUNDED" } });
      // An online order that is refunded before dispatch gives its reservation
      // back. Already-delivered orders were consumed, so this is a no-op there.
      await settleOrderReservations(tx, { id: orderId, storeId }, "RELEASED");
      await tx.orderStatusHistory.create({
        data: { orderId, storeId, fromStatus: order.status, toStatus: "CANCELLED", reason: reason?.trim() ?? null, actorType: "pos_refund", actorId },
      });
      await tx.paymentStatusHistory.create({
        data: { storeId, orderId, paymentId: null, fromStatus: order.paymentStatus, toStatus: "REFUNDED", reason: `refund: ${reason?.trim() ?? "customer refund"}`.slice(0, 200), actorType: "admin", actorId },
      });
    });
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