// Rice Ops M6 — utang texts. A text is queued in the same transaction as the sale or
// payment behind it (so it can never claim a balance that did not commit), then sent
// by the outbox worker. Sending never blocks the sale: a failure is retried, then the
// row shows "Hindi naipadala" with Ipadala ulit.

import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { toE164 } from "../domain/phone.js";
import { smsProvider, type SmsProvider } from "./sms.provider.js";

type Tx = Prisma.TransactionClient;
export type SmsTemplate = "utang_sale" | "utang_payment" | "utang_adjust" | "utang_monthly" | "utang_overdue";

/** Attempts per text before it rests as FAILED (the outbox retries with backoff). */
export const SMS_MAX_ATTEMPTS = 3;

/**
 * Queue a text for a store customer inside the caller's transaction. Returns the row id.
 * No valid mobile number, or texts switched off → SKIPPED (recorded, never sent).
 */
export async function queueSms(
  tx: Tx,
  input: { storeId: string; storeCustomerId: string; template: SmsTemplate; text: string; documentType?: string | null; documentId?: string | null; periodKey?: string | null; createdById?: string | null },
): Promise<{ id: string; status: "QUEUED" | "SKIPPED" }> {
  const [sc, settings] = await Promise.all([
    tx.storeCustomer.findFirst({ where: { id: input.storeCustomerId, storeId: input.storeId }, select: { customer: { select: { phone: true } } } }),
    tx.storeSettings.findUnique({ where: { storeId: input.storeId }, select: { utangSmsEnabled: true } }),
  ]);
  const phone = toE164(sc?.customer.phone ?? "");
  const off = settings ? !settings.utangSmsEnabled : false;
  const status = !phone || off ? "SKIPPED" : "QUEUED";
  const row = await tx.smsMessage.create({
    data: {
      storeId: input.storeId, storeCustomerId: input.storeCustomerId, phone: phone || null, template: input.template, text: input.text,
      status, lastError: off ? "Naka-off ang text sa settings" : !phone ? "Walang mobile number" : null,
      documentType: input.documentType ?? null, documentId: input.documentId ?? null, periodKey: input.periodKey ?? null, createdById: input.createdById ?? null,
    },
    select: { id: true },
  });
  if (status === "QUEUED") {
    await tx.outboxEvent.create({ data: { storeId: input.storeId, aggregateType: "sms", aggregateId: row.id, eventType: "sms.send", payload: { smsId: row.id } } });
  }
  return { id: row.id, status };
}

/**
 * Send one queued (or failed) text. Claimed with an optimistic attempt counter so two
 * workers never send the same text twice. Returns the resulting status.
 */
export async function deliverSms(id: string, provider: SmsProvider = smsProvider()): Promise<{ status: "SENT" | "FAILED" | "SKIPPED" | "NOOP"; attempts: number }> {
  const row = await prisma.smsMessage.findUnique({ where: { id }, include: { store: { select: { settings: { select: { smsSenderName: true } } } } } });
  if (!row || row.status === "SENT" || row.status === "SKIPPED") return { status: "NOOP", attempts: row?.attempts ?? 0 };
  if (!row.phone) {
    await prisma.smsMessage.update({ where: { id }, data: { status: "SKIPPED", lastError: "Walang mobile number" } });
    return { status: "SKIPPED", attempts: row.attempts };
  }
  const claimed = await prisma.smsMessage.updateMany({ where: { id, status: row.status, attempts: row.attempts }, data: { attempts: { increment: 1 } } });
  if (claimed.count === 0) return { status: "NOOP", attempts: row.attempts };
  const attempts = row.attempts + 1;
  try {
    const r = await provider.send(row.phone, row.text, row.store.settings?.smsSenderName ?? null);
    await prisma.smsMessage.update({ where: { id }, data: { status: "SENT", sentAt: new Date(), provider: provider.name, providerMessageId: r.providerMessageId, lastError: null } });
    return { status: "SENT", attempts };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await prisma.smsMessage.update({ where: { id }, data: { status: "FAILED", provider: provider.name, lastError: msg } });
    return { status: "FAILED", attempts };
  }
}

/** Ipadala ulit: re-read the customer's number (it may have been fixed) and send now. */
export async function resendSms(storeId: string, id: string, provider: SmsProvider = smsProvider()) {
  const row = await prisma.smsMessage.findFirst({ where: { id, storeId }, include: { storeCustomer: { select: { customer: { select: { phone: true } } } } } });
  if (!row) return { ok: false as const, error: { type: "not_found" as const, message: "Hindi makita ang text" } };
  if (row.status === "SENT") return { ok: false as const, error: { type: "conflict" as const, message: "Naipadala na ito" } };
  const phone = toE164(row.storeCustomer?.customer.phone ?? row.phone ?? "");
  if (!phone) return { ok: false as const, error: { type: "validation" as const, errors: ["Walang tamang mobile number ang customer — ayusin muna"] } };
  await prisma.smsMessage.update({ where: { id }, data: { phone, status: "FAILED", lastError: null } });
  const r = await deliverSms(id, provider);
  const after = await prisma.smsMessage.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, lastError: true, attempts: true } });
  return { ok: true as const, value: { ...after, sent: r.status === "SENT" } };
}

/** Outbox hook: throw while a failed text still has attempts left, so the worker retries it later. */
export async function handleSmsEvent(payload: Record<string, unknown>): Promise<void> {
  const id = typeof payload.smsId === "string" ? payload.smsId : "";
  if (!id) return;
  const r = await deliverSms(id);
  if (r.status === "FAILED" && r.attempts < SMS_MAX_ATTEMPTS) throw new Error("sms send failed — will retry");
}

export async function listSms(storeId: string, f: { storeCustomerId?: string; status?: string; take?: number } = {}) {
  const status = f.status && ["QUEUED", "SENT", "FAILED", "SKIPPED"].includes(f.status) ? (f.status as "QUEUED" | "SENT" | "FAILED" | "SKIPPED") : undefined;
  return prisma.smsMessage.findMany({
    where: { storeId, ...(f.storeCustomerId ? { storeCustomerId: f.storeCustomerId } : {}), ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(f.take ?? 50, 1), 200),
    select: { id: true, storeCustomerId: true, phone: true, template: true, text: true, status: true, provider: true, attempts: true, lastError: true, createdAt: true, sentAt: true, storeCustomer: { select: { customer: { select: { name: true } } } } },
  });
}
