// Credit (utang) ledger — per-store customer open balances.
// - approveCredit: owner/manager approves a customer for utang with a limit.
// - sellOnCredit: POS/online credit sale → CreditEntry(purchase, +amount), balance up.
// - recordPayment: cash settlement → CreditEntry(payment, -amount) + Payment row.
// - utangList: customers with outstanding balances.
// Limits: per-customer creditLimitMinor, else store settings creditLimitMinor; 0 = disabled.

import { prisma } from "../persistence/prisma-repositories.js";
import { cacheGet, cacheSet, cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { RegisterService } from "../registers/register.service.js";
import type { ApiError } from "@sam-store/contracts";

/** Both ledger lists (unpaid/paid) + customers are stale after any credit write. */
const bustLedger = async (storeId: string) => {
  await cacheBust(cacheKey("credit-ledger", storeId));
  await cacheBust(cacheKey("customers", storeId));
};

export type CreditResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** Row shape returned by utangList (Unpaid/Paid list). */
export interface LedgerListRow {
  id: string; customerName: string | null; phone: string | null; balanceMinor: number; creditLimitMinor: number;
  creditApproved: boolean; firstPurchaseAt: Date | null; oldestDueAt: Date | null; daysOverdue: number; paidAt: Date | null;
}

export const CREDIT_SERVICE = Symbol("CREDIT_SERVICE");

export class CreditService {
  private readonly _prisma = prisma;
  /** N1: drawer attribution for counter utang settlements. */
  private readonly registers = new RegisterService();
  /** Approve a store customer for utang with a limit (minor units). */
  async approveCredit(storeId: string, storeCustomerId: string, limitMinor: number, actorId: string): Promise<CreditResult<{ id: string; creditApproved: boolean; creditLimitMinor: number }>> {
    if (!Number.isInteger(limitMinor) || limitMinor < 0) {
      return { ok: false, error: { type: "validation", errors: ["limitMinor must be a non-negative integer"] } };
    }
    const sc = await prisma.storeCustomer.findFirst({ where: { storeId, id: storeCustomerId } });
    if (!sc) return { ok: false, error: { type: "not_found", message: "Customer not found in this store" } };
    const updated = await prisma.storeCustomer.update({
          where: { id: sc.id },
          data: { creditApproved: true, creditLimitMinor: limitMinor, creditUnlimited: false },
        });
        await bustLedger(storeId);
        return { ok: true, value: { id: updated.id, creditApproved: updated.creditApproved, creditLimitMinor: updated.creditLimitMinor } };
  }

  /** Effective limit for a customer: null = no limit; else the customer's own limit, else the store default. */
  async effectiveLimit(storeId: string, sc: { creditLimitMinor: number; creditUnlimited?: boolean }): Promise<number | null> {
      if (sc.creditUnlimited) return null;
      if (sc.creditLimitMinor > 0) return sc.creditLimitMinor;
      const settings = await this._prisma.storeSettings.findUnique({ where: { storeId } });
      return settings?.creditLimitMinor ?? 0;
    }

  /** V1: store credit term (days) for default due dates. */
  async effectiveTermDays(storeId: string): Promise<number> {
      const settings = await this._prisma.storeSettings.findUnique({ where: { storeId } });
      return settings?.creditTermDays ?? 30;
    }

  /** V1: default dueAt from term (or an explicit dueAt). */
  private async defaultDueAt(storeId: string, startAt: Date | undefined, dueAt: string | undefined): Promise<{ start: Date; due: Date | null }> {
    const start = startAt ?? new Date();
    if (dueAt) return { start, due: new Date(dueAt) };
    const term = await this.effectiveTermDays(storeId);
    return { start, due: new Date(start.getTime() + term * 86_400_000) };
  }

  /**
   * Record a credit purchase (debt) against a customer. Call inside the order transaction.
   * Rice Ops M6: the limit is enforced in ONE guarded statement (two sales racing can no
   * longer both slip under the limit). `overLimitApprovedBy` = the owner approved this
   * sale over the limit (Para sa iyo) — the only way past it.
   */
  async sellOnCredit(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], storeId: string, storeCustomerId: string, orderId: string, amountMinor: number, actorId: string, opts: { startAt?: string; dueAt?: string; overLimitApprovedBy?: string } = {}): Promise<CreditResult<{ balanceMinor: number }>> {
    const sc = await tx.storeCustomer.findFirst({ where: { storeId, id: storeCustomerId } });
    if (!sc) return { ok: false, error: { type: "not_found", message: "Customer not found in this store" } };
    if (!sc.creditApproved) return { ok: false, error: { type: "conflict", message: "Customer is not approved for credit" } };
    if (!opts.overLimitApprovedBy) {
      const limit = await this.effectiveLimit(storeId, sc);
      if (limit !== null && limit <= 0) return { ok: false, error: { type: "conflict", message: "Credit is disabled for this store" } };
      if (limit === null) {
        await tx.storeCustomer.update({ where: { id: sc.id }, data: { creditBalanceMinor: { increment: amountMinor } } });
      } else {
        const guarded = await tx.storeCustomer.updateMany({
          where: { id: sc.id, storeId, creditBalanceMinor: { lte: limit - amountMinor } },
          data: { creditBalanceMinor: { increment: amountMinor } },
        });
        if (guarded.count === 0) {
          return { ok: false, error: { type: "conflict", message: `Credit limit reached (limit ₱${(limit / 100).toFixed(2)}). The customer must pay first.` } };
        }
      }
    } else {
      await tx.storeCustomer.update({ where: { id: sc.id }, data: { creditBalanceMinor: { increment: amountMinor } } });
    }
    const { start, due } = await this.defaultDueAt(storeId, opts.startAt ? new Date(opts.startAt) : undefined, opts.dueAt);
    await tx.creditEntry.create({
      data: {
        storeId, storeCustomerId, orderId, type: "purchase", amountMinor, startAt: start, dueAt: due, createdBy: actorId,
        note: opts.overLimitApprovedBy ? "Credit (approved by the owner, over the limit)" : "POS credit sale",
      },
    });
    const updated = await tx.storeCustomer.findUniqueOrThrow({ where: { id: sc.id }, select: { creditBalanceMinor: true } });
    await bustLedger(storeId);
    return { ok: true, value: { balanceMinor: updated.creditBalanceMinor } };
  }

  /** Read-only eligibility check for online credit checkout. */
  async checkCredit(storeId: string, storeCustomerId: string, amountMinor: number): Promise<{ ok: true } | { ok: false; message: string }> {
    const sc = await prisma.storeCustomer.findFirst({ where: { storeId, id: storeCustomerId } });
    if (!sc) return { ok: false, message: "Customer not found in this store" };
    if (!sc.creditApproved) return { ok: false, message: "Customer is not approved for credit" };
    const limit = await this.effectiveLimit(storeId, sc);
    if (limit === null) return { ok: true };
    if (limit <= 0) return { ok: false, message: "Credit is disabled for this store" };
    if (sc.creditBalanceMinor + amountMinor > limit) {
      return { ok: false, message: `Credit limit reached (limit ₱${(limit / 100).toFixed(2)}). The customer must pay first.` };
    }
    return { ok: true };
  }

  /** Record an online credit purchase (after order creation). M6: order-idempotent — a retry never double-counts. */
    async recordPurchase(orderId: string, storeId: string, storeCustomerId: string, amountMinor: number, startAt?: string, dueAt?: string): Promise<void> {
      const { start, due } = await this.defaultDueAt(storeId, startAt ? new Date(startAt) : undefined, dueAt);
      await prisma.$transaction(async (tx) => {
        const existing = await tx.creditEntry.findFirst({ where: { storeId, orderId, type: "purchase" } });
        if (existing) return; // idempotent — the purchase for this order is already recorded
        await tx.creditEntry.create({
          data: { storeId, storeCustomerId, orderId, type: "purchase", amountMinor, startAt: start, dueAt: due, note: "Online credit checkout", createdBy: null },
        });
        await tx.storeCustomer.update({
          where: { id: storeCustomerId },
          data: { creditBalanceMinor: { increment: amountMinor } },
        });
      });
    }

    /** Record a cash payment against utang. v4: signature REQUIRED (data-URL PNG). */
    async recordPayment(storeId: string, storeCustomerId: string, amountMinor: number, note: string | undefined, actorId: string, signatureData?: string): Promise<CreditResult<{ balanceMinor: number; paymentId: string }>> {
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        return { ok: false, error: { type: "validation", errors: ["amountMinor must be a positive integer"] } };
      }
      if (!signatureData || typeof signatureData !== "string" || !signatureData.trim().startsWith("data:image/") || signatureData.length > 2_000_000) {
        return { ok: false, error: { type: "validation", errors: ["Signature is required (draw to confirm)"] } };
      }
      const sc = await prisma.storeCustomer.findFirst({ where: { storeId, id: storeCustomerId } });
      if (!sc) return { ok: false, error: { type: "not_found", message: "Customer not found in this store" } };
      if (sc.creditBalanceMinor <= 0) return { ok: false, error: { type: "conflict", message: "Customer has no outstanding balance" } };
      const pay = Math.min(amountMinor, sc.creditBalanceMinor);

      const payment = await prisma.$transaction(async (tx) => {
        // N1: attribute the settlement to the open shift (if any) so it is visible in
        // that shift's report. Its tender method is recorded as "credit" — the ledger
        // side of utang; the drawer's cash math counts only cash tenders.
        const registerSessionId = await this.registers.attachOpenSession(storeId);
        const p = await tx.payment.create({
          data: { storeId, method: "credit", amountMinor: pay, note: note?.trim() ?? "Credit payment", type: "payment", createdBy: actorId, signatureData, registerSessionId },
        });
        await tx.creditEntry.create({
          data: { storeId, storeCustomerId, type: "payment", amountMinor: -pay, note: note?.trim() ?? "Credit payment", createdBy: actorId },
        });
        const updated = await tx.storeCustomer.update({
          where: { id: sc.id },
          data: { creditBalanceMinor: { decrement: pay } },
        });
        return { paymentId: p.id, balanceMinor: updated.creditBalanceMinor };
      });
      await bustLedger(storeId);
      return { ok: true, value: payment };
    }

  /** Customers with outstanding balances (Utang list). V1: status = unpaid | paid.
   *  Filters: search (customer name, case-insensitive), from/to (inclusive createdAt range on CreditEntry). */
  async utangList(storeId: string, status: "unpaid" | "paid" = "unpaid", f: { search?: string; from?: Date; to?: Date } = {}): Promise<LedgerListRow[]> {
        const plain = !f.search && !f.from && !f.to;
            if (plain) {
              const hit = await cacheGet<LedgerListRow[]>(cacheKey("credit-ledger", storeId, status));
              if (hit) return hit;
            }
      const range: Record<string, Date> = {};
    if (f.from) range.gte = f.from;
    if (f.to) range.lte = f.to;
    const where: Record<string, unknown> = {
      storeId,
      credit: { some: Object.keys(range).length > 0 ? { createdAt: range } : {} },
    };
    if (status === "unpaid") where.creditBalanceMinor = { gt: 0 };
    else where.creditBalanceMinor = { equals: 0 };
    if (f.search?.trim()) {
      where.customer = { name: { contains: f.search.trim(), mode: "insensitive" } };
    }
    const rows = await prisma.storeCustomer.findMany({
          where,
          orderBy: status === "unpaid" ? { creditBalanceMinor: "desc" } : { updatedAt: "desc" },
          include: {
            customer: { select: { name: true, phone: true } },
            credit: { orderBy: { createdAt: "asc" }, select: { type: true, createdAt: true, startAt: true, dueAt: true } },
          },
        });
        const mapped: LedgerListRow[] = rows.map((r) => {
          const purchases = r.credit.filter((e) => e.type === "purchase");
          const payments = r.credit.filter((e) => e.type === "payment");
          const oldestDue = purchases.reduce<Date | null>((m, e) => (e.dueAt && (!m || e.dueAt < m) ? e.dueAt : m), null);
          const firstPurchaseAt = purchases[0]?.startAt ?? null;
          const paidAt = payments.length > 0 ? payments[payments.length - 1]!.createdAt : null;
          const daysOverdue = oldestDue && oldestDue.getTime() < Date.now() ? Math.floor((Date.now() - oldestDue.getTime()) / 86_400_000) : 0;
          return {
            id: r.id,
            customerName: r.customer.name,
            phone: r.customer.phone,
            balanceMinor: r.creditBalanceMinor,
            creditLimitMinor: r.creditLimitMinor,
            creditApproved: r.creditApproved,
            firstPurchaseAt,
            oldestDueAt: oldestDue,
            daysOverdue,
            paidAt,
          };
        });
        if (plain) await cacheSet(cacheKey("credit-ledger", storeId, status), mapped, 15_000);
        return mapped;
      }

  /** Full ledger for one customer. from/to filter the entries by createdAt (inclusive).
     *  v4: each entry carries its signature (payment data-URL) when available. */
    async customerCredit(storeId: string, storeCustomerId: string, opts: { from?: Date; to?: Date } = {}) {
      const range: { gte?: Date; lte?: Date } = {};
      if (opts.from) range.gte = opts.from;
      if (opts.to) range.lte = opts.to;
      const sc = await prisma.storeCustomer.findFirst({
        where: { storeId, id: storeCustomerId },
        include: {
          customer: { select: { name: true, phone: true } },
          credit: { where: { createdAt: range }, orderBy: { createdAt: "desc" }, take: 100 },
        },
      });
      if (!sc) return null;
      // Fetch signature data from the Payment rows that back the ledger's payment entries.
      const paymentSigs = await prisma.payment.findMany({
            where: { storeId, type: "payment", orderId: null, signatureData: { not: null } },
            select: { id: true, signatureData: true, receivedAt: true },
          });
          const sigById = new Map(paymentSigs.map((p) => [p.id, p.signatureData]));

      return {
        id: sc.id,
        customerName: sc.customer.name,
        phone: sc.customer.phone,
        creditApproved: sc.creditApproved,
        creditLimitMinor: sc.creditLimitMinor,
        balanceMinor: sc.creditBalanceMinor,
        entries: sc.credit.map((e) => ({
          id: e.id, type: e.type, amountMinor: e.amountMinor, startAt: e.startAt, dueAt: e.dueAt, note: e.note, orderId: e.orderId, createdAt: e.createdAt,
          signatureData: sigById.get(e.id),
        })),
      };
    }
}