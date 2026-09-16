// N2 — split and partial payments (+ tender/change), and the per-store payment-method
// registry. One command records every tender for an order inside ONE transaction:
//
//   outstanding = order.totalMinor − Σ tenders + Σ refunds   (never negative)
//
// Rules enforced server-side:
//   • Σ(applied amounts) may not exceed the outstanding balance (no overpayment);
//   • a CASH tender may hand over more than it applies — the difference is CHANGE;
//   • non-cash methods that require a reference must carry one;
//   • an utang (CREDIT) tender writes a CreditEntry through the credit service, so the
//     customer's limit guard applies to the credit portion only;
//   • every tender is attributed to the open drawer shift when its method is CASH;
//   • replaying the same idempotencyKey returns the SAME rows (no double charge).
//
// Deliberately NOT stored: a "PARTIAL/PAID" flag. Settlement is DERIVED from the payment
// rows on every read (`settlement` + `outstandingMinor`), so it cannot drift — the enum
// change would also have to touch checkout/delivery/POS semantics for no gain.

import { prisma } from "../persistence/prisma-repositories.js";
import { RegisterService } from "../registers/register.service.js";
import { ensureMethods, prepareTenders, writeTenders } from "./tenders.js";
import type { ApiError } from "@sam-store/contracts";

export const SPLIT_PAYMENT_SERVICE = "SPLIT_PAYMENT_SERVICE";

export type SplitResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface TenderInput {
  methodCode: string;
  amountMinor: number;
  /** Cash handed over (≥ amountMinor). Change = tendered − applied. */
  tenderedMinor?: number;
  /** e-wallet / bank reference (required by methods flagged requiresReference). */
  reference?: string;
}
export type Settlement = "UNPAID" | "PARTIAL" | "PAID" | "OVERPAID";

export interface PaymentSummary {
  orderId: string;
  orderNumber: string;
  totalMinor: number;
  paidMinor: number; // Σ applied tenders
  refundedMinor: number; // Σ refunds (positive)
  outstandingMinor: number;
  changeMinor: number; // Σ change handed back
  settlement: Settlement;
  tenders: {
    id: string;
    method: string;
    amountMinor: number;
    tenderedMinor: number | null;
    changeMinor: number;
    reference: string | null;
    type: string;
    receivedAt: string;
    createdBy: string | null;
  }[];
}

export class SplitPaymentService {
  private readonly registers = new RegisterService();

  /** The store's payment methods, seeded on first use (shared with the POS paths). */
  async ensureMethods(storeId: string) {
    return ensureMethods(storeId);
  }

  async listMethods(storeId: string) {
    const methods = await this.ensureMethods(storeId);
    return methods;
  }

  async upsertMethod(storeId: string, input: { code: string; label: string; kind?: string; requiresReference?: boolean; enabled?: boolean; sortOrder?: number }) {
    const code = input.code?.trim().toLowerCase();
    if (!code || !/^[a-z0-9_]{2,32}$/.test(code)) {
      return { ok: false as const, error: { type: "validation", errors: ["code must be 2-32 chars of a-z 0-9 _"] } as ApiError };
    }
    const label = input.label?.trim();
    if (!label || label.length > 60) {
      return { ok: false as const, error: { type: "validation", errors: ["label is required (max 60 chars)"] } as ApiError };
    }
    const kind = (input.kind ?? "OTHER").toUpperCase();
    if (!["CASH", "CREDIT", "EWALLET", "TRANSFER", "OTHER"].includes(kind)) {
      return { ok: false as const, error: { type: "validation", errors: ["kind must be CASH, CREDIT, EWALLET, TRANSFER or OTHER"] } as ApiError };
    }
    const method = await prisma.paymentMethod.upsert({
      where: { storeId_code: { storeId, code } },
      update: {
        label,
        kind: kind as never,
        requiresReference: input.requiresReference ?? false,
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
      create: {
        storeId,
        code,
        label,
        kind: kind as never,
        requiresReference: input.requiresReference ?? false,
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    return { ok: true as const, value: method };
  }

  /** Derived settlement for an order (single source of truth = the payment rows). */
  async summaryFor(storeId: string, orderId: string): Promise<PaymentSummary | null> {
    const order = await prisma.order.findFirst({ where: { id: orderId, storeId }, select: { id: true, orderNumber: true, totalMinor: true } });
    if (!order) return null;
    const rows = await prisma.payment.findMany({
      where: { storeId, orderId },
      orderBy: { receivedAt: "asc" },
      select: { id: true, method: true, amountMinor: true, tenderedMinor: true, changeMinor: true, reference: true, type: true, receivedAt: true, createdBy: true },
    });
    const paidMinor = rows.filter((r) => r.type !== "void" && r.amountMinor > 0).reduce((s, r) => s + r.amountMinor, 0);
    const refundedMinor = rows.filter((r) => r.type === "refund").reduce((s, r) => s + -r.amountMinor, 0);
    const net = paidMinor - refundedMinor;
    const outstandingMinor = Math.max(0, order.totalMinor - net);
    const settlement: Settlement =
      order.totalMinor === 0 ? "PAID" : net <= 0 ? "UNPAID" : net > order.totalMinor ? "OVERPAID" : outstandingMinor > 0 ? "PARTIAL" : "PAID";
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalMinor: order.totalMinor,
      paidMinor,
      refundedMinor,
      outstandingMinor,
      changeMinor: rows.reduce((s, r) => s + r.changeMinor, 0),
      settlement,
      tenders: rows.map((r) => ({
        id: r.id,
        method: r.method,
        amountMinor: r.amountMinor,
        tenderedMinor: r.tenderedMinor,
        changeMinor: r.changeMinor,
        reference: r.reference,
        type: r.type,
        receivedAt: r.receivedAt.toISOString(),
        createdBy: r.createdBy,
      })),
    };
  }

  /**
   * Record one or more tenders against an order. Idempotent by (orderId, idempotencyKey).
   */
  async recordTenders(
    storeId: string,
    actorId: string,
    orderId: string,
    input: { tenders: TenderInput[]; idempotencyKey: string; note?: string },
  ): Promise<SplitResult<PaymentSummary>> {
    const key = input.idempotencyKey?.trim();
    if (!key || key.length < 8 || key.length > 200) {
      return { ok: false, error: { type: "validation", errors: ["idempotencyKey is required (8-200 chars)"] } };
    }
    if (!Array.isArray(input.tenders) || input.tenders.length === 0) {
      return { ok: false, error: { type: "validation", errors: ["at least one tender is required"] } };
    }
    if (input.tenders.length > 8) {
      return { ok: false, error: { type: "validation", errors: ["at most 8 tenders per payment"] } };
    }

    // Replay: the same key already produced rows for this order → return them unchanged.
    const replayed = await prisma.payment.findFirst({ where: { storeId, orderId, idempotencyKey: key }, select: { id: true } });
    if (replayed) {
      const summary = await this.summaryFor(storeId, orderId);
      return summary ? { ok: true, value: summary } : { ok: false, error: { type: "not_found", message: "Order not found" } };
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      select: { id: true, orderNumber: true, totalMinor: true, status: true, storeCustomerId: true, customerName: true },
    });
    if (!order) return { ok: false, error: { type: "not_found", message: "Order not found" } };
    if (order.status === "CANCELLED") {
      return { ok: false, error: { type: "conflict", message: "A cancelled order cannot take payments" } };
    }

    // M1: validation + writing now live in payments/tenders.ts so the POS paths share them.
    const before = await this.summaryFor(storeId, orderId);
    const prepared = await prepareTenders({
      storeId,
      orderId,
      targetMinor: order.totalMinor,
      outstandingMinor: before?.outstandingMinor ?? order.totalMinor,
      storeCustomerId: order.storeCustomerId,
      tenders: input.tenders,
    });
    if (!prepared.ok) return prepared;
    const plan = prepared.value;

    // Every tender taken during an open shift belongs to that shift's report (cash
    // counts toward the drawer, the rest is listed as non-cash takings).
    const registerSessionId = await this.registers.attachOpenSession(storeId);

    try {
      await prisma.$transaction(async (tx) => {
        await writeTenders(tx, {
          storeId,
          orderId,
          actorId,
          plan,
          note: input.note?.trim() ?? (plan.prepared.length > 1 ? `Split payment (${plan.prepared.length} tenders)` : null),
          idempotencyKey: key,
          registerSessionId,
        });
        // Settlement is derived, but the order's own status must still flip to COLLECTED
        // once nothing is outstanding (delivery/POS read that column).
        const netAfter = (before?.paidMinor ?? 0) + plan.appliedMinor - (before?.refundedMinor ?? 0);
        if (netAfter >= order.totalMinor) {
          await tx.order.update({ where: { id: orderId }, data: { paymentStatus: "COLLECTED" } });
        }
        if (plan.prepared.length === 1) {
          const only = plan.prepared[0]!;
          await tx.order.update({
            where: { id: orderId },
            data: { paymentMethod: only.kind === "CREDIT" ? "credit" : only.kind === "CASH" ? "cash" : only.code },
          });
        }
      }, { timeout: 30_000 });
    } catch (e) {
      // Nothing partial survives (the transaction rolled back) — surface a clean
      // conflict instead of a 500 (credit limit, ledger guard, unique violations).
      const msg = e instanceof Error ? e.message : "Payment could not be recorded";
      return { ok: false, error: { type: "conflict", message: msg } };
    }

    const summary = await this.summaryFor(storeId, orderId);
    return summary ? { ok: true, value: summary } : { ok: false, error: { type: "not_found", message: "Order not found" } };
  }
}