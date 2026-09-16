// M1 — ONE writer for payment rows.
//
// Every money path (POS quick sale, POS hold-complete, the order-level split endpoint)
// validates its tenders here and writes them here, so the rules can not drift between
// paths: over-payment, cash tender/change, reference requirements, credit limit guard
// and drawer attribution all live in this file.
import { prisma } from "../persistence/prisma-repositories.js";
import { CreditService } from "../credit/credit.service.js";
import type { Prisma } from "@prisma/client";
import type { ApiError } from "@sam-store/contracts";

const credit = new CreditService();

/** Methods a store gets the first time it takes a payment. */
export const DEFAULT_METHODS: {
  code: string; label: string; kind: "CASH" | "CREDIT" | "EWALLET" | "TRANSFER"; requiresReference: boolean; sortOrder: number;
}[] = [
  { code: "cash", label: "Cash", kind: "CASH", requiresReference: false, sortOrder: 0 },
  { code: "credit", label: "Utang (credit)", kind: "CREDIT", requiresReference: false, sortOrder: 1 },
  { code: "gcash", label: "GCash", kind: "EWALLET", requiresReference: true, sortOrder: 2 },
  { code: "maya", label: "Maya", kind: "EWALLET", requiresReference: true, sortOrder: 3 },
  { code: "bank_transfer", label: "Bank transfer", kind: "TRANSFER", requiresReference: true, sortOrder: 4 },
];

export type MethodKind = "CASH" | "CREDIT" | "EWALLET" | "TRANSFER" | "OTHER";

export interface TenderInput {
  methodCode: string;
  amountMinor: number;
  /** Cash handed over (≥ amountMinor). Change = tendered − applied. */
  tenderedMinor?: number;
  /** e-wallet / bank reference (required by methods flagged requiresReference). */
  reference?: string;
}

export interface PreparedTender {
  code: string;
  label: string;
  kind: MethodKind;
  appliedMinor: number;
  tenderedMinor: number | null;
  changeMinor: number;
  reference: string | null;
}

export interface TenderPlan {
  storeId: string;
  orderId: string;
  storeCustomerId: string | null;
  prepared: PreparedTender[];
  appliedMinor: number;
  changeMinor: number;
  cashAppliedMinor: number;
  creditAppliedMinor: number;
  hasCash: boolean;
  hasCredit: boolean;
}

export type TenderResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** The store's payment methods, seeded on first use. */
export async function ensureMethods(storeId: string) {
  const existing = await prisma.paymentMethod.count({ where: { storeId } });
  if (existing === 0) {
    await prisma.paymentMethod.createMany({
      data: DEFAULT_METHODS.map((m) => ({ ...m, storeId })),
      skipDuplicates: true,
    });
  }
  return prisma.paymentMethod.findMany({ where: { storeId }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
}

export interface PrepareInput {
  storeId: string;
  orderId: string;
  /** The amount this payment must settle (order total, or the final total of a POS sale). */
  targetMinor: number;
  /** Amount still outstanding — defaults to targetMinor (fresh order). */
  outstandingMinor?: number;
  storeCustomerId?: string | null;
  tenders: TenderInput[];
  /** POS sales settle in full; the order-level endpoint allows a partial payment. */
  requireFullCoverage?: boolean;
}

/**
 * Validate every tender against the store's methods and the outstanding balance.
 * Collects nothing and writes nothing — the caller owns the transaction.
 */
export async function prepareTenders(input: PrepareInput): Promise<TenderResult<TenderPlan>> {
  const { storeId, orderId, targetMinor, tenders } = input;
  if (!Array.isArray(tenders) || tenders.length === 0) {
    return { ok: false, error: { type: "validation", errors: ["at least one tender is required"] } };
  }
  if (tenders.length > 8) {
    return { ok: false, error: { type: "validation", errors: ["at most 8 tenders per payment"] } };
  }

  const methods = await ensureMethods(storeId);
  const byCode = new Map(methods.map((m) => [m.code, m]));

  const prepared: PreparedTender[] = [];
  let appliedMinor = 0;
  for (const t of tenders) {
    const method = byCode.get((t.methodCode ?? "").trim().toLowerCase());
    if (!method) return { ok: false, error: { type: "validation", errors: [`unknown payment method: ${t.methodCode}`] } };
    if (!method.enabled) return { ok: false, error: { type: "conflict", message: `${method.label} is disabled for this store` } };
    if (!Number.isInteger(t.amountMinor) || t.amountMinor <= 0) {
      return { ok: false, error: { type: "validation", errors: [`amountMinor must be a positive integer (${method.code})`] } };
    }
    const reference = t.reference?.trim() || null;
    if (method.requiresReference && !reference) {
      return { ok: false, error: { type: "validation", errors: [`${method.label} requires a reference number`] } };
    }
    let tenderedMinor: number | null = null;
    let changeMinor = 0;
    if (method.kind === "CASH") {
      tenderedMinor = t.tenderedMinor === undefined ? t.amountMinor : t.tenderedMinor;
      if (!Number.isInteger(tenderedMinor) || tenderedMinor < t.amountMinor) {
        return { ok: false, error: { type: "validation", errors: ["cash tendered cannot be less than the amount applied"] } };
      }
      changeMinor = tenderedMinor - t.amountMinor;
    } else if (t.tenderedMinor !== undefined) {
      return { ok: false, error: { type: "validation", errors: [`only cash tenders can hand over more than they apply (${method.code})`] } };
    }
    if (method.kind === "CREDIT") {
      if (!input.storeCustomerId) {
        return { ok: false, error: { type: "validation", errors: ["Utang requires a customer linked to the order"] } };
      }
      // Fast-fail on the customer's remaining limit BEFORE anything is written.
      const check = await credit.checkCredit(storeId, input.storeCustomerId, t.amountMinor);
      if (!check.ok) return { ok: false, error: { type: "conflict", message: check.message } };
    }
    appliedMinor += t.amountMinor;
    prepared.push({
      code: method.code,
      label: method.label,
      kind: method.kind as MethodKind,
      appliedMinor: t.amountMinor,
      tenderedMinor,
      changeMinor,
      reference,
    });
  }

  const outstanding = input.outstandingMinor ?? targetMinor;
  if (appliedMinor > outstanding) {
    return {
      ok: false,
      error: { type: "conflict", message: `Tenders exceed the outstanding balance of ₱${(outstanding / 100).toFixed(2)}` },
    };
  }
  if (input.requireFullCoverage && appliedMinor < outstanding) {
    return {
      ok: false,
      error: {
        type: "conflict",
        message: `A counter sale must be settled in full — ₱${((outstanding - appliedMinor) / 100).toFixed(2)} short`,
      },
    };
  }

  const cashAppliedMinor = prepared.filter((p) => p.kind === "CASH").reduce((s, p) => s + p.appliedMinor, 0);
  const creditAppliedMinor = prepared.filter((p) => p.kind === "CREDIT").reduce((s, p) => s + p.appliedMinor, 0);
  return {
    ok: true,
    value: {
      storeId,
      orderId,
      storeCustomerId: input.storeCustomerId ?? null,
      prepared,
      appliedMinor,
      changeMinor: prepared.reduce((s, p) => s + p.changeMinor, 0),
      cashAppliedMinor,
      creditAppliedMinor,
      hasCash: cashAppliedMinor > 0,
      hasCredit: creditAppliedMinor > 0,
    },
  };
}

export interface WriteInput {
  storeId: string;
  orderId: string;
  actorId: string;
  plan: TenderPlan;
  note?: string | null;
  idempotencyKey?: string | null;
  registerSessionId?: string | null;
  /** Utang terms for CREDIT tenders (POS passes the sale's start/due dates). */
  creditTerms?: { startAt?: string; dueAt?: string };
}

/**
 * Write the prepared tenders inside the caller's transaction. Cash / e-wallet / transfer
 * rows become Payment rows; credit rows go through CreditService so the ledger entry and
 * the limit guard stay in one place.
 */
export async function writeTenders(tx: Prisma.TransactionClient, input: WriteInput): Promise<void> {
  for (const p of input.plan.prepared) {
    // EVERY tender gets its Payment row (credit included — it is the tender record;
    // the ledger entry below is the separate accounting fact).
    await tx.payment.create({
      data: {
        orderId: input.orderId,
        storeId: input.storeId,
        method: p.code,
        amountMinor: p.appliedMinor,
        tenderedMinor: p.tenderedMinor,
        changeMinor: p.changeMinor,
        reference: p.reference,
        idempotencyKey: input.idempotencyKey ?? null,
        note: input.note ?? null,
        type: "payment",
        createdBy: input.actorId,
        registerSessionId: input.registerSessionId ?? null,
      },
    });
    if (p.kind === "CREDIT") {
      // The credit service owns the limit guard + ledger entry (idempotent per order).
      const res = await credit.sellOnCredit(
        tx as never, input.storeId, input.plan.storeCustomerId!, input.orderId, p.appliedMinor, input.actorId,
        input.creditTerms,
      );
      if (!res.ok) throw new Error("message" in res.error ? res.error.message : "Credit declined");
    }
  }
}
