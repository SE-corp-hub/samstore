// Rice Ops M6 — Utang: the customer list, limits, Bayad sa utang at any store, the money
// side of returns, and the reminder texts.
//
//   * Customers: name + mobile; the owner/manager sets the credit limit (no limit = no utang).
//   * Bayad sa utang: cash or GCash at ANY location; partial is fine; the money goes to
//     that location's drawer; the customer's single balance drops in one guarded write;
//     a text goes out with what is left.
//   * REFUND approvals (M3 returns / refused deliveries): on approval an utang sale's
//     balance is reduced (a cash sale gets a refund row to pay out from the drawer).
//   * Reminders: a monthly balance text and an overdue text, once per period.

import type { ApiError } from "@sam-store/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { toE164 } from "../domain/phone.js";
import { checkPayment, daysSince, manilaParts, monthKey, monthlyText, overdueText, paymentText, pesoText, refundValue, UtangError, weekKey } from "../domain/utang.js";
import { prepareTenders } from "../payments/tenders.js";
import { RegisterService } from "../registers/register.service.js";
import { queueSms } from "../sms/sms.service.js";
import { wakeOutbox } from "../notifications/outbox.service.js";
import {
  captureSignatures, locationRefusal, registerApprovalHandler, requireSignatures, signatureErrorResult,
  type Actor, type SignatureInput,
} from "../people/people.service.js";
import { txOptions } from "../persistence/tx-options.js";

export type UtangResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
type Tx = Prisma.TransactionClient;

class StepError extends Error {
  constructor(readonly result: { ok: false; error: ApiError }) {
    super("utang step refused");
  }
}
const invalid = (m: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [m] } });
const conflict = (m: string) => ({ ok: false as const, error: { type: "conflict" as const, message: m } });
const forbidden = (m: string) => ({ ok: false as const, error: { type: "forbidden" as const, message: m } });
const notFound = (m: string) => ({ ok: false as const, error: { type: "not_found" as const, message: m } });

const LIMIT_ROLES = ["OWNER", "MANAGER", "STORE_OWNER"];
const MAX_LIMIT_MINOR = 100_000_000; // ₱1,000,000

const bustCredit = async (storeId: string) => {
  await cacheBust(cacheKey("credit-ledger", storeId));
  await cacheBust(cacheKey("customers", storeId));
};

// ─────────── the money side of a return (M3 REFUND approvals) ───────────

registerApprovalHandler("REFUND", async (tx, a) => {
  if (a.status !== "APPROVED") return;
  const approval = await tx.approvalRequest.findUnique({ where: { id: a.id }, select: { detail: true, locationId: true } });
  const detail = (approval?.detail ?? {}) as Record<string, unknown>;
  let orderId = typeof detail.orderId === "string" ? detail.orderId : null;
  let productId: string | null = null;
  let units = 0;
  if (a.documentType === "RELEASE") {
    const t = await tx.stockTransfer.findFirst({ where: { id: a.documentId, storeId: a.storeId }, select: { productId: true, orderId: true } });
    productId = t?.productId ?? null;
    orderId = orderId ?? t?.orderId ?? null;
    units = Number(detail.pendingReturn ?? detail.quantity ?? 0);
  } else if (a.documentType === "RETURN") {
    const r = await tx.stockReturn.findFirst({ where: { id: a.documentId, storeId: a.storeId }, select: { productId: true, orderId: true, quantity: true } });
    productId = r?.productId ?? null;
    orderId = orderId ?? r?.orderId ?? null;
    units = r?.quantity ?? 0;
  }
  if (!orderId || !productId || !Number.isInteger(units) || units <= 0) return; // nothing to settle (no order behind it)
  const order = await tx.order.findFirst({ where: { id: orderId, storeId: a.storeId }, select: { id: true, orderNumber: true, paymentMethod: true, storeCustomerId: true, source: true, status: true, items: { where: { productId }, select: { soldBy: true, unitPriceMinor: true, quantity: true, lineTotalMinor: true } } } });
  const line = order?.items[0];
  if (!order || !line) return;
  if (order.source === "AGENT" && order.status !== "COMPLETED") return; // not paid yet — nothing to give back
  const value = refundValue(line, units);
  if (value <= 0) return;
  const note = `Returned (${order.orderNumber})`;
  if (order.paymentMethod === "credit" && order.storeCustomerId) {
    const sc = await tx.storeCustomer.findUniqueOrThrow({ where: { id: order.storeCustomerId }, select: { creditBalanceMinor: true } });
    const reduce = Math.min(value, Math.max(0, sc.creditBalanceMinor));
    if (reduce > 0) {
      await tx.storeCustomer.update({ where: { id: order.storeCustomerId }, data: { creditBalanceMinor: { decrement: reduce } } });
      await tx.creditEntry.create({ data: { storeId: a.storeId, storeCustomerId: order.storeCustomerId, orderId: order.id, type: "adjustment", amountMinor: -reduce, note, createdBy: a.decidedById } });
      const after = sc.creditBalanceMinor - reduce;
      await queueSms(tx, {
        storeId: a.storeId, storeCustomerId: order.storeCustomerId, template: "utang_adjust",
        text: `Nabawasan ang utang ninyo ng ${pesoText(reduce, "P")} (ibinalik na bigas). Natitirang utang: ${pesoText(after, "P")}. Salamat po!`,
        documentType: "APPROVAL", documentId: a.id, createdById: a.decidedById,
      });
    }
    // Anything already paid beyond the remaining balance is handed back as cash.
    if (value > reduce) {
      await tx.payment.create({ data: { storeId: a.storeId, orderId: order.id, method: "cash", amountMinor: value - reduce, type: "refund", status: "pending", note: `${note} — more than the credit owed, give back to the customer`, createdBy: a.decidedById, locationId: approval?.locationId ?? null } });
    }
  } else {
    await tx.payment.create({ data: { storeId: a.storeId, orderId: order.id, method: order.paymentMethod, amountMinor: value, type: "refund", status: "pending", note: `${note} — give back to the customer`, createdBy: a.decidedById, locationId: approval?.locationId ?? null } });
  }
});

export class UtangService {
  private readonly registers = new RegisterService();

  private async run<T>(fn: () => Promise<T>): Promise<UtangResult<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof StepError) return e.result;
      if (e instanceof UtangError) return invalid(e.message);
      const sig = signatureErrorResult(e);
      if (sig) return sig;
      throw e;
    }
  }

  private async location(storeId: string, actor: Actor, locationId: string | undefined) {
    const id = locationId || actor.homeLocationId || (await prisma.warehouse.findFirst({ where: { storeId, isDefault: true }, select: { id: true } }))?.id;
    const loc = id ? await prisma.warehouse.findFirst({ where: { id, storeId, isActive: true }, select: { id: true, name: true } }) : null;
    if (!loc) throw new StepError(invalid("Choose a location"));
    const refusal = locationRefusal(actor, loc.id);
    if (refusal) throw new StepError(forbidden(refusal));
    return loc;
  }

  // ─────────────────────────── customers ───────────────────────────

  async customers(storeId: string, f: { search?: string } = {}) {
    const q = f.search?.trim();
    const [rows, settings] = await Promise.all([
      prisma.storeCustomer.findMany({
        where: { storeId, ...(q ? { customer: { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q.replace(/\D/g, "").slice(-7) || q } }] } } : {}) },
        include: {
          customer: { select: { name: true, phone: true } },
          credit: { where: { type: "purchase" }, orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } },
          smsMessages: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, createdAt: true } },
        },
        orderBy: [{ creditBalanceMinor: "desc" }, { createdAt: "desc" }],
        take: 300,
      }),
      prisma.storeSettings.findUnique({ where: { storeId }, select: { creditLimitMinor: true } }),
    ]);
    return rows.map((r) => ({
      id: r.id, name: r.customer.name ?? "", phone: r.customer.phone, balanceMinor: r.creditBalanceMinor, creditApproved: r.creditApproved,
      limitMinor: r.creditLimitMinor > 0 ? r.creditLimitMinor : settings?.creditLimitMinor ?? 0, ownLimit: r.creditLimitMinor > 0,
      oldestUtangAt: r.creditBalanceMinor > 0 ? r.credit[0]?.createdAt ?? null : null,
      lastText: r.smsMessages[0] ?? null,
    }));
  }

  /** Add a customer to the list (name + mobile). Only the owner/manager gives them a limit. */
  async addCustomer(storeId: string, actor: Actor, input: { name?: string; phone?: string; limitMinor?: unknown }) {
    return this.run(async () => {
      const name = input.name?.trim().replace(/\s+/g, " ") ?? "";
      if (name.length < 2 || name.length > 80) throw new UtangError("Enter the name");
      const phone = toE164(input.phone ?? "");
      if (!phone) throw new UtangError("Enter a valid mobile number (09xx xxx xxxx)");
      const limit = input.limitMinor;
      if (limit !== undefined && limit !== null) {
        if (!LIMIT_ROLES.includes(actor.role)) throw new StepError(forbidden("Only the owner can set the limit"));
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT_MINOR) throw new UtangError("Invalid limit");
      }
      const out = await prisma.$transaction(async (tx) => {
        // The same mobile is the same person (one Customer across stores; one StoreCustomer per store).
        const existing = await tx.customer.findFirst({ where: { phone }, select: { id: true } });
        const customer = existing ?? (await tx.customer.create({ data: { name, phone, email: null, passwordHash: null }, select: { id: true } }));
        const before = await tx.storeCustomer.findUnique({ where: { storeId_customerId: { storeId, customerId: customer.id } }, select: { id: true } });
        if (before) throw new StepError(conflict("This number is already on the list"));
        const sc = await tx.storeCustomer.create({
          data: { storeId, customerId: customer.id, ...(typeof limit === "number" ? { creditLimitMinor: limit, creditApproved: limit > 0 } : {}) },
          select: { id: true, creditApproved: true, creditLimitMinor: true },
        });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "utang.customer_add", entityType: "StoreCustomer", entityId: sc.id, after: { name, limitMinor: typeof limit === "number" ? limit : null } } });
        return { id: sc.id, name, phone, creditApproved: sc.creditApproved, limitMinor: sc.creditLimitMinor };
      });
      await bustCredit(storeId);
      return out;
    });
  }

  /** The owner/manager sets (or removes, with 0) a customer's utang limit. */
  async setLimit(storeId: string, actor: Actor, storeCustomerId: string, limitMinor: unknown) {
    if (!LIMIT_ROLES.includes(actor.role)) return forbidden("Only the owner can set the limit");
    if (typeof limitMinor !== "number" || !Number.isInteger(limitMinor) || limitMinor < 0 || limitMinor > MAX_LIMIT_MINOR) return invalid("Invalid limit");
    const sc = await prisma.storeCustomer.findFirst({ where: { id: storeCustomerId, storeId }, select: { id: true, creditLimitMinor: true } });
    if (!sc) return notFound("Customer not found");
    const updated = await prisma.storeCustomer.update({ where: { id: sc.id }, data: { creditLimitMinor: limitMinor, creditApproved: limitMinor > 0 }, select: { id: true, creditApproved: true, creditLimitMinor: true } });
    await prisma.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "utang.limit", entityType: "StoreCustomer", entityId: sc.id, before: { limitMinor: sc.creditLimitMinor }, after: { limitMinor } } });
    await bustCredit(storeId);
    return { ok: true as const, value: { id: updated.id, creditApproved: updated.creditApproved, limitMinor: updated.creditLimitMinor } };
  }

  // ─────────────────────────── Bayad sa utang ───────────────────────────

  async collect(
    storeId: string, actor: Actor,
    input: { customerId?: string; amountMinor?: unknown; method?: string; reference?: string; tenderedMinor?: unknown; locationId?: string; signatures?: SignatureInput[] },
  ): Promise<UtangResult<{ paymentId: string; amountMinor: number; balanceMinor: number; changeMinor: number; smsId: string; smsStatus: string }>> {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const method = input.method === "gcash" ? "gcash" : input.method === "cash" || input.method === undefined ? "cash" : null;
      if (!method) throw new UtangError("Cash or GCash?");
      const sc = input.customerId ? await prisma.storeCustomer.findFirst({ where: { id: input.customerId, storeId }, select: { id: true, creditBalanceMinor: true } }) : null;
      if (!sc) throw new StepError(notFound("Choose a customer"));
      const amount = checkPayment(sc.creditBalanceMinor, input.amountMinor);
      // Same tender rules as a sale (cash change, GCash reference) — validated, not written here.
      const prepared = await prepareTenders({
        storeId, orderId: "utang-payment", targetMinor: amount, tenders: [{ methodCode: method, amountMinor: amount, ...(method === "cash" && typeof input.tenderedMinor === "number" ? { tenderedMinor: input.tenderedMinor } : {}), ...(input.reference ? { reference: input.reference } : {}) }],
        requireFullCoverage: true,
      });
      if (!prepared.ok) throw new StepError(prepared);
      const tender = prepared.value.prepared[0]!;
      const registerSessionId = await this.registers.sessionAt(storeId, loc.id);
      const hasCustomerSig = (input.signatures ?? []).some((s) => s.signerKind === "CUSTOMER");
      const out = await prisma.$transaction(async (tx) => {
        // ONE guarded write: two payments racing can never take the balance below zero.
        const took = await tx.storeCustomer.updateMany({ where: { id: sc.id, storeId, creditBalanceMinor: { gte: amount } }, data: { creditBalanceMinor: { decrement: amount } } });
        if (took.count === 0) throw new StepError(conflict("The credit changed during payment — check the balance again"));
        const payment = await tx.payment.create({
          data: {
            storeId, method, amountMinor: amount, tenderedMinor: tender.tenderedMinor, changeMinor: tender.changeMinor, reference: tender.reference,
            type: "payment", status: "paid", note: `Credit payment (${loc.name})`, createdBy: actor.userId, registerSessionId, locationId: loc.id,
          },
          select: { id: true },
        });
        await captureSignatures(tx, storeId, actor, { documentType: "UTANG", documentId: payment.id, step: "PAYMENT", locationId: loc.id }, input.signatures);
        await requireSignatures(tx, storeId, { documentType: "UTANG", documentId: payment.id, step: "PAYMENT" }, { customer: hasCustomerSig });
        await tx.creditEntry.create({ data: { storeId, storeCustomerId: sc.id, type: "payment", amountMinor: -amount, note: `Payment at ${loc.name} (${method})`, createdBy: actor.userId, paymentId: payment.id } });
        const after = await tx.storeCustomer.findUniqueOrThrow({ where: { id: sc.id }, select: { creditBalanceMinor: true } });
        const sms = await queueSms(tx, {
          storeId, storeCustomerId: sc.id, template: "utang_payment", text: paymentText({ amountMinor: amount, balanceMinor: after.creditBalanceMinor }),
          documentType: "PAYMENT", documentId: payment.id, createdById: actor.userId,
        });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "utang.payment", entityType: "Payment", entityId: payment.id, after: { amountMinor: amount, method, locationId: loc.id, balanceMinor: after.creditBalanceMinor } } });
        return { paymentId: payment.id, amountMinor: amount, balanceMinor: after.creditBalanceMinor, changeMinor: tender.changeMinor, smsId: sms.id, smsStatus: sms.status };
      }, txOptions());
      await bustCredit(storeId);
      wakeOutbox();
      return out;
    });
  }

  // ─────────────────────────── reminders ───────────────────────────

  /**
   * Queue the reminder texts that are due now. Idempotent: one monthly text per customer per
   * month (sent from the 1st), one overdue text per customer per week. Safe to run every hour.
   */
  async runReminders(storeId: string, now = new Date()): Promise<{ monthly: number; overdue: number }> {
    const [settings, store] = await Promise.all([
      prisma.storeSettings.findUnique({ where: { storeId }, select: { utangSmsEnabled: true, utangMonthlyReminder: true, utangOverdueReminder: true, utangOverdueDays: true } }),
      prisma.store.findUnique({ where: { id: storeId }, select: { name: true } }),
    ]);
    const enabled = settings?.utangSmsEnabled ?? true;
    if (!enabled || !store) return { monthly: 0, overdue: 0 };
    const owing = await prisma.storeCustomer.findMany({
      where: { storeId, creditBalanceMinor: { gt: 0 } },
      select: { id: true, creditBalanceMinor: true, customer: { select: { name: true } }, credit: { where: { type: "purchase" }, orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } } },
    });
    let monthly = 0;
    let overdue = 0;
    const once = async (data: Parameters<typeof queueSms>[1]) => {
      try {
        await prisma.$transaction((tx) => queueSms(tx, data));
        return true;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false; // already sent this period
        throw e;
      }
    };
    for (const c of owing) {
      const name = c.customer.name ?? "po";
      // The monthly balance goes out in the first days of the month (once — the period key).
      if ((settings?.utangMonthlyReminder ?? true) && manilaParts(now).day <= 3) {
        if (await once({ storeId, storeCustomerId: c.id, template: "utang_monthly", text: monthlyText({ customerName: name, balanceMinor: c.creditBalanceMinor, storeName: store.name, at: now }), periodKey: monthKey(now) })) monthly++;
      }
      const since = c.credit[0]?.createdAt;
      const days = since ? daysSince(since, now) : 0;
      if ((settings?.utangOverdueReminder ?? true) && days > (settings?.utangOverdueDays ?? 30)) {
        if (await once({ storeId, storeCustomerId: c.id, template: "utang_overdue", text: overdueText({ customerName: name, balanceMinor: c.creditBalanceMinor, days, storeName: store.name }), periodKey: weekKey(now) })) overdue++;
      }
    }
    if (monthly + overdue > 0) wakeOutbox();
    return { monthly, overdue };
  }

  async settings(storeId: string) {
    const s = await prisma.storeSettings.findUnique({ where: { storeId }, select: { utangSmsEnabled: true, utangMonthlyReminder: true, utangOverdueReminder: true, utangOverdueDays: true, smsSenderName: true, creditLimitMinor: true } });
    return s ?? { utangSmsEnabled: true, utangMonthlyReminder: true, utangOverdueReminder: true, utangOverdueDays: 30, smsSenderName: null, creditLimitMinor: 0 };
  }

  async updateSettings(storeId: string, actor: Actor, input: Record<string, unknown>) {
    if (!LIMIT_ROLES.includes(actor.role)) return forbidden("Only the owner can change this");
    const patch: { utangSmsEnabled?: boolean; utangMonthlyReminder?: boolean; utangOverdueReminder?: boolean; utangOverdueDays?: number; smsSenderName?: string | null } = {};
    for (const k of ["utangSmsEnabled", "utangMonthlyReminder", "utangOverdueReminder"] as const) {
      const v = input[k];
      if (typeof v === "boolean") patch[k] = v;
    }
    if (input.utangOverdueDays !== undefined) {
      const d = input.utangOverdueDays;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 7 || d > 365) return invalid("How many days before a reminder? (7–365)");
      patch.utangOverdueDays = d;
    }
    if (input.smsSenderName !== undefined) {
      const n = typeof input.smsSenderName === "string" ? input.smsSenderName.trim() : "";
      if (n && !/^[A-Za-z0-9 ]{1,11}$/.test(n)) return invalid("Sender name: up to 11 letters or numbers");
      patch.smsSenderName = n || null;
    }
    const row = await prisma.storeSettings.upsert({ where: { storeId }, update: patch, create: { storeId, ...patch } });
    await prisma.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "utang.settings", entityType: "StoreSettings", entityId: row.id, after: patch } });
    return { ok: true as const, value: await this.settings(storeId) };
  }
}
