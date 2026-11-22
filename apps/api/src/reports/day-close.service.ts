// Open day + Close day (Z-read) on POS — Settings → Selling at the counter → "Open and close the day on POS".
//
// One day = one drawer shift (RegisterSession) of ONE store, for ONE Manila date:
//   Open day   the store's own drawer (Register with locationId), the change fund counted in.
//   X-read     the same figures as the Z-read, any time, without closing.
//   Close day  cash (bill by bill or one total) and GCash counted, checked against what should be
//              there, a reason when it does not match, signature → Z-read with the next Z number.
//              It also writes the day's DailyClose, so every older report sees the day as closed.
//   Reopen     owner only, with a reason. The Z-read stays (marked reopened); the next close is a new Z.
//
// Cash "should be" = change fund + the cash book of the day (cash/cash-book.ts: cash in + cash added
// ("Cash in" on POS) − given back − expenses from the drawer − handed to the owner). GCash "should be" = GCash taken − GCash given back.

import { Prisma } from "@prisma/client";
import type { ApiError } from "@sam-store/contracts";
import { prisma } from "../persistence/prisma-repositories.js";
import { dayRange, manilaDate, ReportError } from "../domain/reports.js";
import { captureSignatures, locationRefusal, seesAllStores, requireSignatures, signatureErrorResult, type Actor, type SignatureInput } from "../people/people.service.js";
import { closedDay, dayModeOn, openDayAt } from "../day/day-gate.js";
import { switchesOfAll } from "../day/store-switches.js";
import { mainLocationId, paymentsOfStore } from "./sales-book.js";
import { RiceReportsService } from "./rice-reports.service.js";

export type DayResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

class StepError extends Error {
  constructor(readonly result: { ok: false; error: ApiError }) {
    super("day step refused");
  }
}
const invalid = (m: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [m] } });
const conflict = (m: string) => ({ ok: false as const, error: { type: "conflict" as const, message: m } });
const forbidden = (m: string) => ({ ok: false as const, error: { type: "forbidden" as const, message: m } });
const notFound = (m: string) => ({ ok: false as const, error: { type: "not_found" as const, message: m } });

const OWNERS = ["OWNER", "MANAGER", "STORE_OWNER", "PLATFORM_ADMIN"];
const MAX_MINOR = 100_000_000_00; // ₱100M: a typo guard
/** Bills and coins, in centavos, for the bill-by-bill count. */
export const DENOMINATIONS = [100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 100, 25] as const;
export const VARIANCE_REASONS = ["Wrong change given", "Expense not written down", "Cash in not written down", "Walk-in sale not rung up", "Cash handed over not written down", "Counting mistake", "Don't know"] as const;

/** The figures of a Z-read (and an X-read). Frozen in RegisterSession.zTotals at the close. */
export interface DayFigures {
  location: { id: string; name: string };
  businessDate: string;
  zNumber: number | null;
  openedAt: string; openedBy: string;
  closedAt: string | null; closedBy: string | null;
  sales: { count: number; grossMinor: number; takenBackCount: number; takenBackMinor: number; netMinor: number; cashMinor: number; gcashMinor: number; creditMinor: number; otherMinor: number; encodedLater: number };
  receipts: { first: string | null; last: string | null };
  creditCollectedMinor: number;
  cash: { floatMinor: number; inMinor: number; givenBackMinor: number; paidOutMinor: number; handedOverMinor: number; shouldBeMinor: number; countedMinor: number | null; differenceMinor: number | null;
    /** Of the handed over: cash of the owner's own sales that the owner kept (never in the drawer). Missing on Z-reads made before 2026-11-20. */
    ownerKeptMinor?: number;
    /** Handed to the owner but not marked Received yet: still counted in the drawer. */
    handoverWaitingMinor?: number;
    /** Money put into the drawer that is not a sale ("Cash in" on POS). Missing on Z-reads made before it existed. */
    addedMinor?: number };
  /** Rice sold per kilo at this store this day (sell per kilo, 2026-11-20). Missing on older Z-reads. */
  perKilo?: { grams: number; totalMinor: number; lines: number };
  /** Sales the owner rang at this store this day, and whose cash the owner kept. */
  ownerSales?: { orderNumber: string; at: string; totalMinor: number; method: string; ownerKeptMinor: number; by: string }[];
  gcash: { inMinor: number; givenBackMinor: number; shouldBeMinor: number; countedMinor: number | null; differenceMinor: number | null };
  cashOut: { what: string; amountMinor: number; at: string }[];
  /** Each "Cash in" of the day. Missing on older Z-reads. */
  cashAdded?: { what: string; amountMinor: number; at: string }[];
  cashCounts: Record<string, number> | null;
  keepFloatMinor: number | null;
  varianceReason: string | null;
  note: string | null;
  reopened: { at: string; by: string; reason: string } | null;
}

export interface DayStatus {
  on: boolean;
  /** The stores whose own Open day switch is on (each store has its own). */
  onAt: { id: string; name: string }[];
  location: { id: string; name: string } | null;
  today: string;
  open: { id: string; businessDate: string; openedAt: string; openedBy: string; floatMinor: number; stale: boolean } | null;
  closedToday: { id: string; zNumber: number | null; closedAt: string | null } | null;
  /** Change fund kept at the last close of this store (suggested at Open day). */
  suggestFloatMinor: number | null;
}

const isInt = (v: unknown, min = 0) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= MAX_MINOR;

export class DayCloseService {
  private readonly reports = new RiceReportsService();

  private async run<T>(fn: () => Promise<T>): Promise<DayResult<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof StepError) return e.result;
      if (e instanceof ReportError) return invalid(e.message);
      const sig = signatureErrorResult(e);
      if (sig) return sig;
      throw e;
    }
  }

  /** The store this step is for: the one asked for, else the login's own store. */
  private async place(storeId: string, actor: Actor, locationId: string | undefined) {
    const id = locationId || actor.homeLocationId;
    if (!id) throw new StepError(invalid("Choose the store"));
    const refusal = locationRefusal(actor, id);
    if (refusal) throw new StepError(forbidden(refusal));
    const loc = await prisma.warehouse.findFirst({ where: { id, storeId, isActive: true }, select: { id: true, name: true, type: true } });
    if (!loc) throw new StepError(invalid("Choose a store from the list"));
    return { id: loc.id, name: loc.name };
  }

  private async names(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map();
    const users = await prisma.user.findMany({ where: { id: { in: want } }, select: { id: true, name: true, email: true, phone: true } });
    return new Map(users.map((u) => [u.id, u.name?.trim() || u.email || u.phone || "Staff"]));
  }

  // ─────────────────────────── status ───────────────────────────

  async status(storeId: string, actor: Actor, input: { locationId?: string }): Promise<DayResult<DayStatus>> {
    return this.run(async () => {
      const today = manilaDate(new Date());
      const id = input.locationId || actor.homeLocationId;
      // Each store has its own switch: `on` is this store's; with no store, on when any store has it on.
      const all = await switchesOfAll(prisma, storeId);
      const onAt = [...all.entries()].filter(([, s]) => s.dayOpenClose).map(([lid, s]) => ({ id: lid, name: s.name }));
      if (!id) return { on: await dayModeOn(prisma, storeId), onAt, location: null, today, open: null, closedToday: null, suggestFloatMinor: null };
      const loc = await this.place(storeId, actor, id);
      const on = await dayModeOn(prisma, storeId, loc.id);
      const [open, closed, last] = await Promise.all([
        openDayAt(prisma, storeId, loc.id),
        closedDay(prisma, storeId, loc.id, today),
        prisma.registerSession.findFirst({ where: { storeId, locationId: loc.id, status: "CLOSED", keepFloatMinor: { not: null } }, orderBy: { closedAt: "desc" }, select: { keepFloatMinor: true } }),
      ]);
      const names = await this.names([open?.openedBy]);
      return {
        on, onAt, location: loc, today,
        open: open ? { id: open.id, businessDate: open.businessDate ?? today, openedAt: open.openedAt.toISOString(), openedBy: names.get(open.openedBy) ?? "Staff", floatMinor: open.openingFloatMinor, stale: (open.businessDate ?? today) !== today } : null,
        closedToday: closed ? { id: closed.id, zNumber: closed.zNumber, closedAt: closed.closedAt?.toISOString() ?? null } : null,
        suggestFloatMinor: last?.keepFloatMinor ?? null,
      };
    });
  }

  // ─────────────────────────── open ───────────────────────────

  async open(storeId: string, actor: Actor, input: { locationId?: string; openingFloatMinor?: unknown; note?: string }): Promise<DayResult<DayStatus>> {
    const out = await this.run(async () => {
      const loc = await this.place(storeId, actor, input.locationId);
      if (!(await dayModeOn(prisma, storeId, loc.id))) throw new StepError(conflict(`Open day is turned off for ${loc.name}. Turn it on in Settings, This store.`));
      const float = input.openingFloatMinor ?? 0;
      if (!isInt(float)) throw new StepError(invalid("Type the change fund in the drawer (0 if none)"));
      const today = manilaDate(new Date());
      const open = await openDayAt(prisma, storeId, loc.id);
      if (open && open.businessDate === today) return; // opened a moment ago (another tablet, or a retry): fine
      if (open) throw new StepError(conflict(`${loc.name}: the day of ${open.businessDate} is still open. Close it first with Close day, then open today.`));
      if (await closedDay(prisma, storeId, loc.id, today)) throw new StepError(conflict(`${loc.name} is already closed for today. Only the owner can reopen the day.`));
      try {
        await prisma.$transaction(async (tx) => {
          const register = (await tx.register.findFirst({ where: { storeId, locationId: loc.id, status: "ACTIVE" }, select: { id: true } }))
            ?? (await tx.register.create({ data: { storeId, locationId: loc.id, name: `${loc.name} drawer`.slice(0, 80) }, select: { id: true } }));
          const s = await tx.registerSession.create({
            data: { storeId, registerId: register.id, locationId: loc.id, businessDate: today, openedBy: actor.userId, openingFloatMinor: float as number, notes: input.note?.trim().slice(0, 300) || null },
            select: { id: true },
          });
          if ((float as number) > 0) await tx.cashMovement.create({ data: { storeId, sessionId: s.id, type: "FLOAT", amountMinor: float as number, reason: "change fund (Open day)", createdBy: actor.userId } });
          await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "day.open", entityType: "RegisterSession", entityId: s.id, after: { locationId: loc.id, businessDate: today, openingFloatMinor: float } } });
        });
      } catch (e) {
        // Two tablets opening at the same moment: the unique index lets one win; the other is fine.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return;
        throw e;
      }
    });
    if (!out.ok) return out;
    return this.status(storeId, actor, { locationId: input.locationId });
  }

  // ─────────────────────────── figures ───────────────────────────

  private async figures(storeId: string, loc: { id: string; name: string }, session: { id: string; businessDate: string | null; openedAt: Date; openedBy: string; openingFloatMinor: number }): Promise<DayFigures> {
    const date = session.businessDate ?? manilaDate(session.openedAt);
    const { from, to } = dayRange(date);
    const range = { gte: from, lt: to };
    const mainId = await mainLocationId(prisma, storeId);
    const t = await this.reports.dayTotals(storeId, loc.id, date);
    const here = paymentsOfStore(loc.id, mainId);
    const [gIn, gBack, firstSale, lastSale, expenses, handovers, cashIns] = await Promise.all([
      prisma.payment.aggregate({ where: { storeId, type: "payment", method: "gcash", receivedAt: range, ...here }, _sum: { amountMinor: true } }),
      prisma.payment.findMany({ where: { storeId, type: "refund", method: "gcash", receivedAt: range, ...here }, select: { amountMinor: true } }),
      prisma.order.findFirst({ where: { storeId, sellingLocationId: loc.id, occurredAt: range }, orderBy: { occurredAt: "asc" }, select: { orderNumber: true } }),
      prisma.order.findFirst({ where: { storeId, sellingLocationId: loc.id, occurredAt: range }, orderBy: { occurredAt: "desc" }, select: { orderNumber: true } }),
      prisma.expense.findMany({ where: { storeId, locationId: loc.id, paidFromDrawer: true, voidedAt: null, spentAt: range }, select: { category: true, note: true, amountMinor: true, spentAt: true }, orderBy: { spentAt: "asc" } }),
      prisma.cashHandover.findMany({ where: { storeId, locationId: loc.id, businessDate: date, voidedAt: null }, select: { amountMinor: true, note: true, createdAt: true, orderId: true, receivedById: true }, orderBy: { createdAt: "asc" } }),
      prisma.cashIn.findMany({ where: { storeId, locationId: loc.id, voidedAt: null, receivedAt: range }, select: { amountMinor: true, note: true, receivedAt: true }, orderBy: { receivedAt: "asc" } }),
    ]);
    // The owner's own sales here today: rung by the owner's login, or the owner kept the cash.
    const dayOrders = await prisma.order.findMany({
      where: { storeId, sellingLocationId: loc.id, occurredAt: range, status: { not: "CANCELLED" } },
      select: { id: true, orderNumber: true, occurredAt: true, totalMinor: true, paymentMethod: true, statusHistory: { select: { actorId: true }, orderBy: { createdAt: "asc" }, take: 1 } },
      orderBy: { occurredAt: "asc" },
    });
    // Kilo rice sold today (lines sold by the kilo or by pesos worth); already inside the sales above.
    const kiloSum = dayOrders.length ? await prisma.orderItem.aggregate({
      where: { storeId, orderId: { in: dayOrders.map((o) => o.id) }, soldBy: { in: ["KILO", "PESO"] } },
      _sum: { quantity: true, lineTotalMinor: true }, _count: { _all: true },
    }) : null;
    const ringers = [...new Set(dayOrders.map((o) => o.statusHistory[0]?.actorId).filter((x): x is string => !!x))];
    const bosses = new Set(ringers.length ? (await prisma.userStore.findMany({ where: { storeId, userId: { in: ringers }, role: "OWNER" }, select: { userId: true } })).map((u) => u.userId) : []);
    const keptBy = new Map<string, number>();
    for (const h of handovers) if (h.orderId) keptBy.set(h.orderId, (keptBy.get(h.orderId) ?? 0) + h.amountMinor);
    const ownerOrders = dayOrders.filter((o) => keptBy.has(o.id) || bosses.has(o.statusHistory[0]?.actorId ?? ""));
    const names = await this.names([session.openedBy, ...ownerOrders.map((o) => o.statusHistory[0]?.actorId)]);
    const gcashIn = gIn._sum.amountMinor ?? 0;
    const gcashBack = gBack.reduce((s, p) => s + Math.abs(p.amountMinor), 0);
    const float = session.openingFloatMinor;
    return {
      location: loc, businessDate: date, zNumber: null,
      openedAt: session.openedAt.toISOString(), openedBy: names.get(session.openedBy) ?? "Staff", closedAt: null, closedBy: null,
      sales: {
        count: t.sales.count, grossMinor: t.sales.totalMinor + t.sales.takenBack.totalMinor, takenBackCount: t.sales.takenBack.count, takenBackMinor: t.sales.takenBack.totalMinor,
        netMinor: t.sales.totalMinor, cashMinor: t.sales.cashMinor, gcashMinor: t.sales.gcashMinor, creditMinor: t.sales.utangMinor, otherMinor: t.sales.otherMinor, encodedLater: t.sales.encodedLater,
      },
      receipts: { first: firstSale?.orderNumber ?? null, last: lastSale?.orderNumber ?? null },
      creditCollectedMinor: t.utang.collectedMinor,
      perKilo: { grams: kiloSum?._sum.quantity ?? 0, totalMinor: kiloSum?._sum.lineTotalMinor ?? 0, lines: kiloSum?._count._all ?? 0 },
      cash: {
        floatMinor: float, inMinor: t.cash.inMinor, givenBackMinor: t.cash.givenBackMinor, paidOutMinor: t.cash.paidOutMinor, handedOverMinor: t.cash.handedOverMinor,
        shouldBeMinor: float + t.cash.expectedMinor, countedMinor: null, differenceMinor: null,
        ownerKeptMinor: [...keptBy.values()].reduce((a, b) => a + b, 0),
        addedMinor: t.cash.addedMinor,
        handoverWaitingMinor: t.cash.handoverWaitingMinor,
      },
      ownerSales: ownerOrders.map((o) => ({
        orderNumber: o.orderNumber, at: (o.occurredAt ?? new Date()).toISOString(), totalMinor: o.totalMinor, method: o.paymentMethod ?? "",
        ownerKeptMinor: keptBy.get(o.id) ?? 0, by: names.get(o.statusHistory[0]?.actorId ?? "") ?? "Owner",
      })),
      gcash: { inMinor: gcashIn, givenBackMinor: gcashBack, shouldBeMinor: gcashIn - gcashBack, countedMinor: null, differenceMinor: null },
      cashOut: [
        ...expenses.map((e) => ({ what: `Expense: ${e.note?.trim() || e.category}`, amountMinor: e.amountMinor, at: e.spentAt.toISOString() })),
        // Only hand-overs the owner marked Received left the drawer; a waiting one is shown in cash.handoverWaitingMinor.
        ...handovers.filter((h) => h.receivedById).map((h) => ({ what: h.orderId ? `${h.note ?? "Owner's sale"}: the owner kept the cash` : `Handed to the owner${h.note ? `: ${h.note}` : ""}`, amountMinor: h.amountMinor, at: h.createdAt.toISOString() })),
      ],
      cashAdded: cashIns.map((c) => ({ what: c.note?.trim() || "Cash in", amountMinor: c.amountMinor, at: c.receivedAt.toISOString() })),
      cashCounts: null, keepFloatMinor: null, varianceReason: null, note: null, reopened: null,
    };
  }

  /** X-read: the open day's figures now, nothing closed. */
  async xread(storeId: string, actor: Actor, input: { locationId?: string }): Promise<DayResult<DayFigures>> {
    return this.run(async () => {
      const loc = await this.place(storeId, actor, input.locationId);
      const open = await openDayAt(prisma, storeId, loc.id);
      if (!open) throw new StepError(notFound(`${loc.name}: no open day`));
      return this.figures(storeId, loc, open);
    });
  }

  // ─────────────────────────── close (Z-read) ───────────────────────────

  async close(storeId: string, actor: Actor, input: {
    locationId?: string; cashCounts?: unknown; cashCountedMinor?: unknown; gcashCountedMinor?: unknown;
    varianceReason?: string; note?: string; keepFloatMinor?: unknown; signatures?: SignatureInput[];
  }): Promise<DayResult<DayFigures>> {
    return this.run(async () => {
      const loc = await this.place(storeId, actor, input.locationId);
      const session = await openDayAt(prisma, storeId, loc.id);
      if (!session) {
        const today = manilaDate(new Date());
        const done = await closedDay(prisma, storeId, loc.id, today);
        if (done) throw new StepError(conflict(`${loc.name} is already closed for today (Z-${String(done.zNumber ?? 0).padStart(4, "0")}).`));
        throw new StepError(conflict(`${loc.name}: no open day to close`));
      }

      // Bills and coins → total (the server adds them up; the tablet's total is only a check).
      let counts: Record<string, number> | null = null;
      let counted: number;
      if (input.cashCounts && typeof input.cashCounts === "object") {
        counts = {};
        let sum = 0;
        for (const [k, v] of Object.entries(input.cashCounts as Record<string, unknown>)) {
          const value = Number(k);
          if (!(DENOMINATIONS as readonly number[]).includes(value)) throw new StepError(invalid(`Unknown bill or coin: ${k}`));
          if (!isInt(v) || (v as number) > 100_000) throw new StepError(invalid("How many of each bill: whole numbers only"));
          if ((v as number) > 0) { counts[k] = v as number; sum += value * (v as number); }
        }
        counted = sum;
        if (isInt(input.cashCountedMinor) && (input.cashCountedMinor as number) !== counted) throw new StepError(invalid("The bills and coins do not add up to the total — count again"));
      } else {
        if (!isInt(input.cashCountedMinor)) throw new StepError(invalid("Type the cash you counted in the drawer"));
        counted = input.cashCountedMinor as number;
      }
      if (!isInt(input.gcashCountedMinor)) throw new StepError(invalid("Type today's GCash total from the GCash app (0 if none)"));
      const gcashCounted = input.gcashCountedMinor as number;
      const keep = input.keepFloatMinor ?? null;
      if (keep !== null && (!isInt(keep) || (keep as number) > counted)) throw new StepError(invalid("The change fund for tomorrow cannot be more than the cash counted"));

      const fig = await this.figures(storeId, loc, session);
      const cashDiff = counted - fig.cash.shouldBeMinor;
      const gcashDiff = gcashCounted - fig.gcash.shouldBeMinor;
      const reason = input.varianceReason?.trim().slice(0, 200) || null;
      if ((cashDiff !== 0 || gcashDiff !== 0) && !reason) throw new StepError(invalid("The count does not match — choose why before closing"));

      const now = new Date();
      const date = fig.businessDate;
      const totals = await this.reports.dayTotals(storeId, loc.id, date);
      try {
        return await prisma.$transaction(async (tx) => {
          const last = await tx.registerSession.aggregate({ where: { storeId, locationId: loc.id }, _max: { zNumber: true } });
          const zNumber = (last._max.zNumber ?? 0) + 1;
          const names = await this.names([actor.userId]);
          const z: DayFigures = {
            ...fig, zNumber, closedAt: now.toISOString(), closedBy: names.get(actor.userId) ?? "Staff",
            cash: { ...fig.cash, countedMinor: counted, differenceMinor: cashDiff },
            gcash: { ...fig.gcash, countedMinor: gcashCounted, differenceMinor: gcashDiff },
            cashCounts: counts, keepFloatMinor: keep as number | null, varianceReason: cashDiff !== 0 || gcashDiff !== 0 ? reason : null, note: input.note?.trim().slice(0, 300) || null,
          };
          const moved = await tx.registerSession.updateMany({
            where: { id: session.id, storeId, status: "OPEN" },
            data: {
              status: "CLOSED", closedBy: actor.userId, closedAt: now, countedMinor: counted, expectedMinor: fig.cash.shouldBeMinor, varianceMinor: cashDiff,
              zNumber, gcashExpectedMinor: fig.gcash.shouldBeMinor, gcashCountedMinor: gcashCounted, cashCounts: (counts ?? Prisma.JsonNull) as Prisma.InputJsonValue,
              varianceReason: z.varianceReason, keepFloatMinor: keep as number | null, zTotals: z as unknown as Prisma.InputJsonValue,
            },
          });
          if (moved.count !== 1) throw new StepError(conflict("This day was closed a moment ago — refresh"));
          // The day's DailyClose, so every older report shows the day as closed (cash there is without the change fund, as before).
          const row = await tx.dailyClose.create({
            data: {
              storeId, locationId: loc.id, businessDate: date, totals: { ...totals, zRead: { sessionId: session.id, zNumber } } as unknown as Prisma.InputJsonValue,
              cashExpectedMinor: totals.cash.expectedMinor, cashCountedMinor: counted - fig.cash.floatMinor, cashVarianceMinor: cashDiff,
              note: [z.varianceReason, z.note].filter(Boolean).join(" · ").slice(0, 300) || null, closedById: actor.userId, closedAt: now,
            },
            select: { id: true },
          });
          await captureSignatures(tx, storeId, actor, { documentType: "CLOSE", documentId: row.id, step: "DAY", locationId: loc.id }, input.signatures);
          await requireSignatures(tx, storeId, { documentType: "CLOSE", documentId: row.id, step: "DAY" });
          await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "day.close", entityType: "RegisterSession", entityId: session.id, after: { locationId: loc.id, date, zNumber, cashShouldBe: fig.cash.shouldBeMinor, cashCounted: counted, gcashShouldBe: fig.gcash.shouldBeMinor, gcashCounted, reason: z.varianceReason } } });
          return z;
        }, { timeout: 30_000 });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new StepError(conflict(`${loc.name} is already closed for ${date}`));
        throw e;
      }
    });
  }

  // ─────────────────────────── reopen (owner) ───────────────────────────

  async reopen(storeId: string, actor: Actor, input: { id?: string; reason?: string }): Promise<DayResult<{ id: string; zNumber: number | null }>> {
    return this.run(async () => {
      if (!OWNERS.includes(actor.role)) throw new StepError(forbidden("Only the owner can reopen a day"));
      const reason = input.reason?.trim().slice(0, 300);
      if (!reason) throw new StepError(invalid("Why reopen the day? Type a reason"));
      const z = await prisma.registerSession.findFirst({ where: { id: input.id ?? "", storeId, status: "CLOSED", zNumber: { not: null } }, select: { id: true, zNumber: true, locationId: true, businessDate: true, registerId: true, openingFloatMinor: true, reopenedAt: true, closedAt: true } });
      if (!z || !z.locationId || !z.businessDate) throw new StepError(notFound("Z-read not found"));
      // 2026-11-22: a manager reopens their own store's day only.
      const notHere = locationRefusal(actor, z.locationId);
      if (notHere) throw new StepError(forbidden(notHere));
      if (z.reopenedAt) throw new StepError(conflict("This day was already reopened"));
      const newer = await prisma.registerSession.findFirst({ where: { storeId, locationId: z.locationId, openedAt: { gt: z.closedAt ?? new Date(0) } }, select: { id: true } });
      if (newer) throw new StepError(conflict("A newer day was opened at this store after this one. Only the last day can be reopened."));
      const now = new Date();
      try {
        const s = await prisma.$transaction(async (tx) => {
          const marked = await tx.registerSession.updateMany({ where: { id: z.id, reopenedAt: null }, data: { reopenedAt: now, reopenedById: actor.userId, reopenReason: reason } });
          if (marked.count !== 1) throw new StepError(conflict("This day was already reopened"));
          const before = await tx.dailyClose.findFirst({ where: { storeId, locationId: z.locationId!, businessDate: z.businessDate! } });
          if (before) await tx.dailyClose.delete({ where: { id: before.id } });
          const opened = await tx.registerSession.create({
            data: { storeId, registerId: z.registerId, locationId: z.locationId, businessDate: z.businessDate, openedBy: actor.userId, openingFloatMinor: z.openingFloatMinor, notes: `Reopened Z-${String(z.zNumber).padStart(4, "0")}: ${reason}`.slice(0, 300) },
            select: { id: true },
          });
          await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "day.reopen", entityType: "RegisterSession", entityId: z.id, before: before ? ({ dailyClose: before } as unknown as Prisma.InputJsonValue) : Prisma.JsonNull, after: { reason, newSessionId: opened.id } } });
          return opened;
        });
        return { id: s.id, zNumber: z.zNumber };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new StepError(conflict("Another day is open at this store — close it first"));
        throw e;
      }
    });
  }

  // ─────────────────────────── list / one ───────────────────────────

  async list(storeId: string, actor: Actor, input: { locationId?: string; from?: string; to?: string }) {
    return this.run(async () => {
      const owner = seesAllStores(actor);
      const locationId = input.locationId || (owner ? undefined : actor.homeLocationId ?? undefined);
      if (!owner && !locationId) throw new StepError(invalid("Choose the store"));
      if (locationId) { const r = locationRefusal(actor, locationId); if (r) throw new StepError(forbidden(r)); }
      const to = input.to || manilaDate(new Date());
      const from = input.from || manilaDate(new Date(Date.now() - 30 * 86_400_000));
      const rows = await prisma.registerSession.findMany({
        where: { storeId, zNumber: { not: null }, businessDate: { gte: from, lte: to }, ...(locationId ? { locationId } : {}) },
        orderBy: [{ businessDate: "desc" }, { closedAt: "desc" }], take: 200,
        select: { id: true, zNumber: true, businessDate: true, locationId: true, closedAt: true, closedBy: true, varianceMinor: true, gcashExpectedMinor: true, gcashCountedMinor: true, varianceReason: true, reopenedAt: true, zTotals: true },
      });
      const locs = new Map((await prisma.warehouse.findMany({ where: { storeId }, select: { id: true, name: true } })).map((w) => [w.id, w.name]));
      const names = await this.names(rows.map((r) => r.closedBy));
      const open = await prisma.registerSession.findMany({ where: { storeId, status: "OPEN", locationId: locationId ?? { not: null } }, select: { id: true, locationId: true, businessDate: true, openedAt: true } });
      return {
        from, to,
        open: open.map((o) => ({ id: o.id, locationId: o.locationId, locationName: locs.get(o.locationId ?? "") ?? "", businessDate: o.businessDate, openedAt: o.openedAt.toISOString() })),
        zreads: rows.map((r) => {
          const z = r.zTotals as unknown as DayFigures | null;
          return {
            id: r.id, zNumber: r.zNumber, businessDate: r.businessDate, locationId: r.locationId, locationName: locs.get(r.locationId ?? "") ?? "",
            closedAt: r.closedAt?.toISOString() ?? null, closedBy: names.get(r.closedBy ?? "") ?? "",
            netSalesMinor: z?.sales.netMinor ?? 0, cashDifferenceMinor: r.varianceMinor ?? 0, gcashDifferenceMinor: (r.gcashCountedMinor ?? 0) - (r.gcashExpectedMinor ?? 0),
            varianceReason: r.varianceReason, reopened: !!r.reopenedAt,
          };
        }),
      };
    });
  }

  async one(storeId: string, actor: Actor, id: string): Promise<DayResult<DayFigures>> {
    return this.run(async () => {
      const r = await prisma.registerSession.findFirst({ where: { id, storeId, zNumber: { not: null } }, select: { locationId: true, zTotals: true, reopenedAt: true, reopenedById: true, reopenReason: true } });
      if (!r || !r.zTotals) throw new StepError(notFound("Z-read not found"));
      const refusal = locationRefusal(actor, r.locationId);
      if (refusal) throw new StepError(forbidden(refusal));
      const z = r.zTotals as unknown as DayFigures;
      if (r.reopenedAt) {
        const names = await this.names([r.reopenedById]);
        z.reopened = { at: r.reopenedAt.toISOString(), by: names.get(r.reopenedById ?? "") ?? "Owner", reason: r.reopenReason ?? "" };
      }
      return z;
    });
  }
}
