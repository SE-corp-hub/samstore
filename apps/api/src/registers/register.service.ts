// N1 — Cash drawer, shifts and Z-report.
//
// A Register is the physical drawer (one per store today); a RegisterSession is one
// cashier's shift on it. Nothing here stores a mutable balance: the expected cash is
// DERIVED from the append-only rows (cash movements + the tenders/refunds recorded
// against the session), so a report can always be recomputed from history.
//
//   expected = opening float
//            + Σ CASH_IN        − Σ CASH_OUT   − Σ REFUND movements
//            + Σ cash tenders   − Σ cash refunds   (signed Payment rows, incl. 0-amount voids)
//
// One open shift per store is guaranteed by a partial unique index (migration
// 20260913121631), so a concurrent double-open loses on the constraint instead of
// creating two drawers.

import { prisma } from "../persistence/prisma-repositories.js";

export const REGISTER_SERVICE = "REGISTER_SERVICE";

export type RegisterError = { type: "conflict" | "not_found" | "validation"; message: string };
export type RegisterResult<T> = { ok: true; value: T } | { ok: false; error: RegisterError };

export const CASH_MOVEMENT_TYPES = ["FLOAT", "CASH_IN", "CASH_OUT", "REFUND"] as const;
export type CashMovementTypeName = (typeof CASH_MOVEMENT_TYPES)[number];

/** Payment methods that touch the physical drawer. */
const CASH_METHODS = ["cash"];

export interface SessionTotals {
  openingFloatMinor: number;
  cashInMinor: number;
  cashOutMinor: number;
  cashRefundsMinor: number; // positive number of cash paid back out
  cashSalesMinor: number;
  cashSalesCount: number;
  nonCashSalesMinor: number; // utang/e-wallet/etc. — informational, not in the drawer
  ordersCount: number;
  salesTotalMinor: number;
  byMethod: { method: string; count: number; amountMinor: number }[];
  lastSaleAt: string | null;
  expectedMinor: number;
}

export interface SessionSummary {
  sessionId: string;
  registerId: string;
  registerName: string;
  status: "OPEN" | "CLOSED";
  openedBy: string;
  openedAt: string;
  openingFloatMinor: number;
  closedBy: string | null;
  closedAt: string | null;
  countedMinor: number | null;
  expectedMinor: number | null;
  varianceMinor: number | null;
  notes: string | null;
  live: SessionTotals;
}

export interface ShiftReport {
  kind: "x" | "z";
  session: SessionSummary;
  movements: { type: string; amountMinor: number; reason: string | null; createdBy: string; createdAt: string }[];
}

function round(value: number): number {
  return Math.round(value);
}

export class RegisterService {
  /** The store's single register (created on first use). */
  async ensureRegister(storeId: string): Promise<{ id: string; name: string }> {
    const existing = await prisma.register.findFirst({ where: { storeId, status: "ACTIVE" } });
    if (existing) return { id: existing.id, name: existing.name };
    const created = await prisma.register.create({ data: { storeId, name: "Main counter" } });
    return { id: created.id, name: created.name };
  }

  /** Derived drawer totals for a session (works for OPEN and CLOSED sessions).
   *  Queries run SEQUENTIALLY on purpose: the managed pooler caps sessions and a
   *  parallel burst from one client can exceed it (EMAXCONNSESSION). */
  async totalsFor(storeId: string, sessionId: string): Promise<SessionTotals> {
    const session = await prisma.registerSession.findFirst({ where: { id: sessionId, storeId }, select: { openingFloatMinor: true } });
    const movements = await prisma.cashMovement.findMany({ where: { storeId, sessionId }, select: { type: true, amountMinor: true } });
    const payments = await prisma.payment.findMany({ where: { storeId, registerSessionId: sessionId }, select: { method: true, amountMinor: true, type: true } });
    const orders = await prisma.order.findMany({ where: { storeId, registerSessionId: sessionId }, select: { totalMinor: true, createdAt: true } });

    let cashInMinor = 0;
    let cashOutMinor = 0;
    let refundMovementsMinor = 0;
    for (const m of movements) {
      if (m.type === "CASH_IN") cashInMinor += m.amountMinor;
      else if (m.type === "CASH_OUT") cashOutMinor += m.amountMinor;
      else if (m.type === "REFUND") refundMovementsMinor += m.amountMinor;
      // FLOAT is the opening float, already counted as openingFloatMinor.
    }

    // Signed: cash tenders are positive, refunds negative, voids zero.
    const cashRows = payments.filter((p) => CASH_METHODS.includes(p.method) && p.type !== "void");
    const cashSalesMinor = cashRows.filter((p) => p.amountMinor > 0).reduce((s, p) => s + p.amountMinor, 0);
    const cashRefundsMinor = cashRows.filter((p) => p.amountMinor < 0).reduce((s, p) => s + -p.amountMinor, 0);
    const cashSalesCount = cashRows.filter((p) => p.amountMinor > 0).length;

    const byMethodMap = new Map<string, { count: number; amountMinor: number }>();
    for (const p of payments) {
      if (p.type === "void") continue;
      const entry = byMethodMap.get(p.method) ?? { count: 0, amountMinor: 0 };
      entry.count += 1;
      entry.amountMinor += p.amountMinor;
      byMethodMap.set(p.method, entry);
    }
    const byMethod = [...byMethodMap.entries()].map(([method, v]) => ({ method, count: v.count, amountMinor: v.amountMinor }));

    const nonCashSalesMinor = byMethod.filter((m) => !CASH_METHODS.includes(m.method)).reduce((s, m) => s + m.amountMinor, 0);
    const openingFloatMinor = session?.openingFloatMinor ?? 0;
    const expectedMinor = round(
      openingFloatMinor + cashInMinor - cashOutMinor - refundMovementsMinor + cashSalesMinor - cashRefundsMinor,
    );
    const lastSaleAt = orders.length > 0 ? orders.reduce((a, o) => (o.createdAt > a ? o.createdAt : a), orders[0]!.createdAt).toISOString() : null;

    return {
      openingFloatMinor,
      cashInMinor,
      cashOutMinor,
      cashRefundsMinor,
      cashSalesMinor,
      cashSalesCount,
      nonCashSalesMinor,
      ordersCount: orders.length,
      salesTotalMinor: orders.reduce((s, o) => s + o.totalMinor, 0),
      byMethod,
      lastSaleAt,
      expectedMinor,
    };
  }

  private async toSummary(session: {
    id: string; registerId: string; status: string; openedBy: string; openedAt: Date;
    openingFloatMinor: number; closedBy: string | null; closedAt: Date | null;
    countedMinor: number | null; expectedMinor: number | null; varianceMinor: number | null; notes: string | null;
    register?: { name: string } | null;
  }, storeId: string): Promise<SessionSummary> {
    const live = await this.totalsFor(storeId, session.id);
    return {
      sessionId: session.id,
      registerId: session.registerId,
      registerName: session.register?.name ?? "Main counter",
      status: session.status === "CLOSED" ? "CLOSED" : "OPEN",
      openedBy: session.openedBy,
      openedAt: session.openedAt.toISOString(),
      openingFloatMinor: session.openingFloatMinor,
      closedBy: session.closedBy,
      closedAt: session.closedAt ? session.closedAt.toISOString() : null,
      countedMinor: session.countedMinor,
      expectedMinor: session.expectedMinor,
      varianceMinor: session.varianceMinor,
      notes: session.notes,
      live,
    };
  }

  /** The store's open shift, or null. */
  async currentSession(storeId: string): Promise<SessionSummary | null> {
    const session = await prisma.registerSession.findFirst({
      where: { storeId, status: "OPEN" },
      include: { register: { select: { name: true } } },
    });
    if (!session) return null;
    return this.toSummary(session, storeId);
  }

  /** Open a shift. Fails with a conflict when one is already open (DB-enforced). */
  async openSession(storeId: string, actorId: string, input: { openingFloatMinor?: number; notes?: string } = {}): Promise<RegisterResult<SessionSummary>> {
    const openingFloatMinor = input.openingFloatMinor ?? 0;
    if (!Number.isInteger(openingFloatMinor) || openingFloatMinor < 0) {
      return { ok: false, error: { type: "validation", message: "opening float must be a non-negative integer (minor units)" } };
    }
    const register = await this.ensureRegister(storeId);
    try {
      const session = await prisma.$transaction(async (tx) => {
        const created = await tx.registerSession.create({
          data: { storeId, registerId: register.id, openedBy: actorId, openingFloatMinor, notes: input.notes?.trim() || null },
          include: { register: { select: { name: true } } },
        });
        // Opening float is also recorded as a movement so the drawer has an audit trail.
        if (openingFloatMinor > 0) {
          await tx.cashMovement.create({
            data: { storeId, sessionId: created.id, type: "FLOAT", amountMinor: openingFloatMinor, reason: "opening float", createdBy: actorId },
          });
        }
        return created;
      }, { timeout: 30_000 });
      return { ok: true, value: await this.toSummary(session, storeId) };
    } catch (e) {
      // P2002 on the partial unique index (one open shift per store) — a race loser.
      if ((e as { code?: string }).code === "P2002") {
        return { ok: false, error: { type: "conflict", message: "A shift is already open for this store" } };
      }
      throw e;
    }
  }

  /** Cash in / cash out / mid-shift float top-up. Rejected once the shift is closed. */
  async addMovement(storeId: string, actorId: string, input: { type: string; amountMinor: number; reason?: string }): Promise<RegisterResult<SessionSummary>> {
    const type = (input.type ?? "").toUpperCase();
    if (!CASH_MOVEMENT_TYPES.includes(type as CashMovementTypeName)) {
      return { ok: false, error: { type: "validation", message: `type must be one of: ${CASH_MOVEMENT_TYPES.join(", ")}` } };
    }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      return { ok: false, error: { type: "validation", message: "amountMinor must be a positive integer" } };
    }
    const session = await prisma.registerSession.findFirst({ where: { storeId, status: "OPEN" }, select: { id: true } });
    if (!session) return { ok: false, error: { type: "conflict", message: "No open shift — open a shift before recording cash movements" } };

    await prisma.cashMovement.create({
      data: { storeId, sessionId: session.id, type: type as CashMovementTypeName, amountMinor: input.amountMinor, reason: input.reason?.trim() || null, createdBy: actorId },
    });
    const summary = await this.currentSession(storeId);
    return { ok: true, value: summary! };
  }

  /**
   * Close the shift: computes the expected cash, stores the counted amount and the
   * variance. The close is a guarded single-statement write, so a concurrent close
   * loses cleanly instead of producing two Z-reports.
   */
  async closeSession(storeId: string, actorId: string, input: { countedMinor: number; notes?: string }): Promise<RegisterResult<SessionSummary>> {
    if (!Number.isInteger(input.countedMinor) || input.countedMinor < 0) {
      return { ok: false, error: { type: "validation", message: "counted cash must be a non-negative integer (minor units)" } };
    }
    const session = await prisma.registerSession.findFirst({ where: { storeId, status: "OPEN" }, include: { register: { select: { name: true } } } });
    if (!session) return { ok: false, error: { type: "conflict", message: "No open shift to close" } };

    const totals = await this.totalsFor(storeId, session.id);
    const expectedMinor = totals.expectedMinor;
    const varianceMinor = input.countedMinor - expectedMinor;

    const closed = await prisma.registerSession.updateMany({
      where: { id: session.id, storeId, status: "OPEN" },
      data: {
        status: "CLOSED",
        closedBy: actorId,
        closedAt: new Date(),
        countedMinor: input.countedMinor,
        expectedMinor,
        varianceMinor,
        notes: input.notes?.trim() ? [session.notes, input.notes.trim()].filter(Boolean).join(" | ") : session.notes,
      },
    });
    if (closed.count === 0) {
      return { ok: false, error: { type: "conflict", message: "This shift was already closed" } };
    }

    const after = await prisma.registerSession.findFirstOrThrow({ where: { id: session.id, storeId }, include: { register: { select: { name: true } } } });
    return { ok: true, value: await this.toSummary(after, storeId) };
  }

  /** X-report (mid-shift snapshot) or Z-report (the closed shift's final figures). */
  async report(storeId: string, kind: "x" | "z" = "x", sessionId?: string): Promise<RegisterResult<ShiftReport>> {
    const session = sessionId
      ? await prisma.registerSession.findFirst({ where: { id: sessionId, storeId }, include: { register: { select: { name: true } } } })
      : await prisma.registerSession.findFirst({ where: { storeId, status: kind === "z" ? "CLOSED" : "OPEN" }, orderBy: { openedAt: "desc" }, include: { register: { select: { name: true } } } });
    if (!session) return { ok: false, error: { type: "not_found", message: kind === "z" ? "No closed shift found for this store" : "No open shift found for this store" } };

    const movements = await prisma.cashMovement.findMany({ where: { storeId, sessionId: session.id }, orderBy: { createdAt: "asc" } });
    return {
      ok: true,
      value: {
        kind,
        session: await this.toSummary(session, storeId),
        movements: movements.map((m) => ({ type: m.type, amountMinor: m.amountMinor, reason: m.reason, createdBy: m.createdBy, createdAt: m.createdAt.toISOString() })),
      },
    };
  }

  /**
   * Attribution helper for the OTHER cash paths (admin-recorded payments, refunds,
   * voids, utang settlements): returns the open shift's id, or null when no shift is
   * open. Never enforces — off-counter money still records, it just is not part of a
   * drawer's expected cash.
   */
  async attachOpenSession(storeId: string): Promise<string | null> {
    const session = await prisma.registerSession.findFirst({ where: { storeId, status: "OPEN" }, select: { id: true } });
    return session?.id ?? null;
  }

  /**
   * POS integration: the session a counter cash sale must attach to.
   * Returns null when the store does not require an open shift (off-counter sales).
   *
   * Enforcement only applies when the store HAS a settings row: the column defaults to
   * true for every store created through the app, while legacy/lightweight stores with no
   * settings row keep their previous behaviour (no shift required).
   */
  async requireOpenSession(storeId: string): Promise<RegisterResult<string | null>> {
    const settings = await prisma.storeSettings.findUnique({ where: { storeId }, select: { requireOpenShift: true } });
    const required = settings?.requireOpenShift ?? false;
    const session = await prisma.registerSession.findFirst({ where: { storeId, status: "OPEN" }, select: { id: true } });
    if (session) return { ok: true, value: session.id };
    if (!required) return { ok: true, value: null };
    return { ok: false, error: { type: "conflict", message: "No open shift — open the cash drawer before taking cash sales" } };
  }

  /** Sessions list for the admin register panel. */
  async listSessions(storeId: string, limit = 20) {
    const sessions = await prisma.registerSession.findMany({
      where: { storeId },
      orderBy: { openedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
      include: { register: { select: { name: true } } },
    });
    return Promise.all(sessions.map((s) => this.toSummary(s, storeId)));
  }
}
