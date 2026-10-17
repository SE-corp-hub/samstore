// Rice Ops M9 — the owner's reports, all read from signed documents and the ledger.
//
//   Stock Live   every product × location (available, held), in transit, in resack, total;
//                pushes a change within seconds of any signed step (shared per-store watcher).
//   Daily        per location: sales by payment, kilos per variety, utang given/collected,
//                stock in, trips, resack loss, write-offs, counts, cash expected vs counted,
//                kargador transactions, open hand-offs. Pagsasara (closing) freezes it.
//   Monthly      sales and gross profit per location and variety, kilos, loss by location and
//                kargador, utang aging, manual items for review, the kargador pay sheet.
//   Balance      the kulang found by counts, ranked by pesos, with who touched the item since.
//   Trace        a document number, customer, kargador, staff or product → the full trail.
//   Alerts       what the owner must look at today.

import { costModeOf, effectiveCost } from "../domain/shelf-cost.js";
import type { ApiError } from "@sam-store/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { aging, dayRange, lineCost, lineGrams, manilaDate, monthRange, pct, ReportError, stockFlag } from "../domain/reports.js";
import { varietyOf } from "../domain/resack.js";
import { costValue, isLooseP } from "../domain/counting.js";
import { checkChain, periodTotals, type ChainCheck, type LedgerRow } from "../domain/stock-book.js";
import { isDraftStale } from "../domain/people.js";
import { captureSignatures, locationRefusal, requireSignatures, signatureErrorResult, type Actor, type SignatureInput } from "../people/people.service.js";

export type ReportResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

class StepError extends Error {
  constructor(readonly result: { ok: false; error: ApiError }) {
    super("report step refused");
  }
}
const invalid = (m: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [m] } });
const conflict = (m: string) => ({ ok: false as const, error: { type: "conflict" as const, message: m } });
const forbidden = (m: string) => ({ ok: false as const, error: { type: "forbidden" as const, message: m } });

const OWNERS = ["OWNER", "MANAGER", "STORE_OWNER", "PLATFORM_ADMIN"];
const RESERVED_ONLY = ["RESERVE", "RELEASE_RESERVATION"];
const productSelect = { id: true, name: true, variety: true, stockBaseUnit: true, stockBaseQuantity: true, costMinor: true, isActive: true, reviewStatus: true } as const;
type P = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

// ─────────────────────────── the live watcher ───────────────────────────

type Listener = (version: string) => void;
const watchers = new Map<string, { listeners: Set<Listener>; timer: NodeJS.Timeout | null; last: string }>();

/** The newest ledger row of a store: any signed step that moves stock changes it. */
export async function stockVersion(storeId: string): Promise<string> {
  const m = await prisma.stockMovement.findFirst({ where: { storeId }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true } });
  return m ? `${m.createdAt.getTime()}:${m.id}` : "0";
}

/**
 * Subscribe to a store's stock changes. ONE poller per store however many phones watch
 * (the database pooler has few slots), every `intervalMs` while anyone is listening.
 */
export function watchStock(storeId: string, listener: Listener, intervalMs = 2_000): () => void {
  let w = watchers.get(storeId);
  if (!w) {
    w = { listeners: new Set(), timer: null, last: "" };
    watchers.set(storeId, w);
    const entry = w;
    // One poll at a time: the next starts `intervalMs` after the previous one ENDS, so a
    // slow database never piles polls up on the pooler's few connections.
    const tick = async () => {
      try {
        const v = await stockVersion(storeId);
        if (entry.last && v !== entry.last) for (const l of entry.listeners) l(v);
        entry.last = v;
      } catch { /* try again next tick */ }
      if (watchers.get(storeId) !== entry) return; // everyone stopped watching
      entry.timer = setTimeout(() => void tick(), intervalMs);
      entry.timer.unref?.();
    };
    void tick();
  }
  w.listeners.add(listener);
  return () => {
    const cur = watchers.get(storeId);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size === 0) {
      if (cur.timer) clearTimeout(cur.timer);
      watchers.delete(storeId);
    }
  };
}

export class RiceReportsService {
  private async run<T>(fn: () => Promise<T>): Promise<ReportResult<T>> {
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

  private owner(actor: Actor) {
    if (!OWNERS.includes(actor.role)) throw new StepError(forbidden("This report is for the owner only"));
  }

  private async locations(storeId: string) {
    return prisma.warehouse.findMany({ where: { storeId, isActive: true }, select: { id: true, name: true, code: true, type: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  }

  // ─────────────────────────── Stock Live ───────────────────────────

  async stockLive(storeId: string) {
    const [locations, products, levels, transit, resacks, version] = await Promise.all([
      this.locations(storeId),
      prisma.product.findMany({ where: { storeId, isActive: true }, select: productSelect, orderBy: { name: "asc" } }),
      prisma.stockLevel.findMany({ where: { storeId, warehouseId: { not: null } }, select: { productId: true, warehouseId: true, quantityOnHand: true, quantityReserved: true } }),
      prisma.stockTransfer.findMany({ where: { storeId, status: { in: ["IN_TRANSIT", "RETURNING"] } }, select: { productId: true, status: true, releasedQty: true, deliveredQty: true, receivedQty: true, returnedQty: true } }),
      prisma.resackJob.findMany({ where: { storeId, status: "STARTED" }, select: { inputProductId: true, inputQty: true } }),
      stockVersion(storeId),
    ]);
    const rows = products.map((p) => {
      const loose = isLooseP(p);
      const cells: Record<string, { onHand: number; reserved: number; available: number; flag: string }> = {};
      let total = 0;
      for (const l of levels.filter((x) => x.productId === p.id)) {
        const available = l.quantityOnHand - l.quantityReserved;
        cells[l.warehouseId!] = { onHand: l.quantityOnHand, reserved: l.quantityReserved, available, flag: stockFlag(loose, available) };
        total += l.quantityOnHand;
      }
      // On the road: released and not yet counted in anywhere (delivered rice has left the business).
      const inTransit = transit.filter((t) => t.productId === p.id).reduce((s, t) => s + (t.status === "IN_TRANSIT" ? t.releasedQty ?? 0 : Math.max(0, (t.releasedQty ?? 0) - (t.deliveredQty ?? 0) - (t.returnedQty ?? 0))), 0);
      const inResack = resacks.filter((r) => r.inputProductId === p.id).reduce((s, r) => s + r.inputQty, 0);
      const gramsPer = p.stockBaseUnit === "g" ? p.stockBaseQuantity : null;
      const all = total + inTransit + inResack;
      return { productId: p.id, name: p.name, loose, gramsPerUnit: gramsPer, cells, inTransit, inResack, total: all, totalGrams: gramsPer ? all * gramsPer : null };
    }).filter((r) => r.total !== 0 || Object.keys(r.cells).length > 0);
    return { version, at: new Date().toISOString(), locations, rows };
  }

  /** Every movement behind a Stock Live cell — with the document and the person. */
  async movements(storeId: string, productId: string, locationId: string | undefined) {
    const rows = await prisma.stockMovement.findMany({
      where: { storeId, productId, ...(locationId ? { warehouseId: locationId } : {}) },
      orderBy: { createdAt: "desc" }, take: 100,
      select: { id: true, type: true, delta: true, balanceAfter: true, documentType: true, documentId: true, createdBy: true, createdAt: true, note: true, warehouseId: true },
    });
    const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdBy ?? ""))] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email]));
    return rows.map((r) => ({ ...r, by: r.createdBy ? users.get(r.createdBy) ?? null : null, reservedOnly: RESERVED_ONLY.includes(r.type) }));
  }

  // ─────────────────────────── Daily ───────────────────────────

  /** The day's numbers for one location, straight from that day's documents. */
  private async dayTotals(storeId: string, locationId: string, date: string) {
    const { from, to } = dayRange(date);
    const range = { gte: from, lt: to };
    // At most 4 queries at a time: the database pooler gives this app few connections,
    // and 10 at once could wait out the pool timeout on a slow link (M9 verify run).
    const [orders, payments, credits, stockIns] = await Promise.all([
      prisma.order.findMany({
        where: { storeId, sellingLocationId: locationId, status: "COMPLETED", OR: [{ occurredAt: range }, { occurredAt: null, createdAt: range }] },
        select: { id: true, totalMinor: true, paymentMethod: true, encodedLater: true, items: { select: { productId: true, soldBy: true, quantity: true, grams: true, lineTotalMinor: true, unitCostMinor: true } } },
      }),
      prisma.payment.findMany({
        where: { storeId, type: "payment", receivedAt: range, OR: [{ locationId }, { locationId: null, order: { sellingLocationId: locationId } }] },
        select: { method: true, amountMinor: true, orderId: true },
      }),
      prisma.creditEntry.findMany({ where: { storeId, createdAt: range, type: "purchase", order: { sellingLocationId: locationId } }, select: { amountMinor: true } }),
      prisma.stockIn.findMany({ where: { storeId, locationId, createdAt: range }, select: { id: true, lines: { select: { quantity: true } } } }),
    ]);
    const [moves, resacks, writeOffs, counts] = await Promise.all([
      prisma.stockMovement.findMany({ where: { storeId, warehouseId: locationId, createdAt: range, type: { in: ["RELEASE_OUT", "RECEIVE_IN", "RETURN_IN"] } }, select: { type: true, delta: true, productId: true } }),
      prisma.resackJob.findMany({ where: { storeId, locationId, status: "FINISHED", finishedAt: range }, select: { inputGrams: true, outputGrams: true, lossGrams: true, lossValueMinor: true, approvalId: true } }),
      prisma.stockWriteOff.findMany({ where: { storeId, locationId, createdAt: range }, select: { valueMinor: true, approvalId: true } }),
      prisma.stockCount.findMany({ where: { storeId, locationId, status: "APPROVED", decidedAt: range }, select: { kind: true, kulangValueMinor: true, sobraValueMinor: true } }),
    ]);
    const [sigs, products] = await Promise.all([
      prisma.signature.findMany({ where: { storeId, locationId, createdAt: range, kargadorId: { not: null } }, select: { kargadorId: true, documentType: true, documentId: true, step: true, kargador: { select: { name: true } } } }),
      prisma.product.findMany({ where: { storeId }, select: productSelect }),
    ]);
    const byProduct = new Map(products.map((p) => [p.id, p]));
    const sales = { count: orders.length, totalMinor: 0, cashMinor: 0, gcashMinor: 0, utangMinor: 0, otherMinor: 0, encodedLater: 0, costMinor: 0 };
    const varieties = new Map<string, { grams: number; salesMinor: number }>();
    for (const o of orders) {
      sales.totalMinor += o.totalMinor;
      if (o.encodedLater) sales.encodedLater++;
      if (o.paymentMethod === "cash") sales.cashMinor += o.totalMinor;
      else if (o.paymentMethod === "gcash") sales.gcashMinor += o.totalMinor;
      else if (o.paymentMethod === "credit") sales.utangMinor += o.totalMinor;
      else sales.otherMinor += o.totalMinor;
      for (const i of o.items) {
        const p = i.productId ? byProduct.get(i.productId) : undefined;
        if (!p) continue;
        sales.costMinor += lineCost(i, p.costMinor, isLooseP(p));
        const g = lineGrams(i, p.stockBaseUnit === "g" ? p.stockBaseQuantity : null);
        if (g > 0) {
          const v = varietyOf(p);
          const cur = varieties.get(v) ?? { grams: 0, salesMinor: 0 };
          cur.grams += g;
          cur.salesMinor += i.lineTotalMinor;
          varieties.set(v, cur);
        }
      }
    }
    const cashIn = payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amountMinor, 0);
    const utangCollected = payments.filter((p) => !p.orderId && p.method !== "credit").reduce((s, p) => s + p.amountMinor, 0);
    const kargadors = new Map<string, { name: string; transactions: number }>();
    const seenDocs = new Set<string>();
    for (const s of sigs) {
      const k = `${s.kargadorId}:${s.documentType}:${s.documentId}:${s.step}`;
      if (seenDocs.has(k)) continue;
      seenDocs.add(k);
      const cur = kargadors.get(s.kargadorId!) ?? { name: s.kargador?.name ?? "", transactions: 0 };
      cur.transactions++;
      kargadors.set(s.kargadorId!, cur);
    }
    return {
      sales: { ...sales, grossProfitMinor: sales.totalMinor - sales.costMinor },
      kilosByVariety: [...varieties.entries()].map(([variety, v]) => ({ variety, grams: v.grams, salesMinor: v.salesMinor })).sort((a, b) => b.grams - a.grams),
      utang: { givenMinor: credits.reduce((s, c) => s + c.amountMinor, 0), collectedMinor: utangCollected },
      cash: { expectedMinor: cashIn },
      stockIn: { documents: stockIns.length, units: stockIns.reduce((s, d) => s + d.lines.reduce((x, l) => x + l.quantity, 0), 0) },
      trips: {
        releasedOut: -moves.filter((m) => m.type === "RELEASE_OUT").reduce((s, m) => s + m.delta, 0),
        receivedIn: moves.filter((m) => m.type === "RECEIVE_IN").reduce((s, m) => s + m.delta, 0),
        returnedIn: moves.filter((m) => m.type === "RETURN_IN").reduce((s, m) => s + m.delta, 0),
      },
      resack: { jobs: resacks.length, gramsIn: resacks.reduce((s, r) => s + r.inputGrams, 0), gramsOut: resacks.reduce((s, r) => s + (r.outputGrams ?? 0), 0), lossGrams: resacks.reduce((s, r) => s + (r.lossGrams ?? 0), 0), lossValueMinor: resacks.reduce((s, r) => s + (r.lossValueMinor ?? 0), 0), waitingOwner: resacks.filter((r) => r.approvalId).length },
      writeOffs: { count: writeOffs.length, valueMinor: writeOffs.reduce((s, w) => s + w.valueMinor, 0), waitingOwner: writeOffs.filter((w) => w.approvalId).length },
      counts: { count: counts.length, kulangMinor: counts.reduce((s, c) => s + c.kulangValueMinor, 0), sobraMinor: counts.reduce((s, c) => s + c.sobraValueMinor, 0) },
      kargadors: [...kargadors.entries()].map(([id, k]) => ({ kargadorId: id, name: k.name, transactions: k.transactions })).sort((a, b) => b.transactions - a.transactions),
    };
  }

  /** Sales and cash that came in at a closed location after its Pagsasara, same day. The closed
   *  report is frozen on purpose, so these would otherwise be invisible to the owner. */
  private async afterClose(storeId: string, locationId: string, date: string, closedAt: Date) {
    const { from, to } = dayRange(date);
    const orders = await prisma.order.findMany({
      where: {
        storeId, sellingLocationId: locationId, status: "COMPLETED", createdAt: { gt: closedAt },
        OR: [{ occurredAt: { gte: from, lt: to } }, { occurredAt: null, createdAt: { gte: from, lt: to } }],
      },
      select: { totalMinor: true, paymentMethod: true },
    });
    const cash = await prisma.payment.findMany({
      where: { storeId, type: "payment", method: "cash", receivedAt: { gt: closedAt, lt: to }, OR: [{ locationId }, { locationId: null, order: { sellingLocationId: locationId } }] },
      select: { amountMinor: true },
    });
    return {
      count: orders.length,
      totalMinor: orders.reduce((a, o) => a + o.totalMinor, 0),
      cashMinor: cash.reduce((a, p) => a + p.amountMinor, 0),
    };
  }

  /** Releases not delivered and resacks not finished at a location — right now. */
  private async openHandOffs(storeId: string, locationId: string) {
    const [trips, resacks] = await Promise.all([
      prisma.stockTransfer.findMany({
        where: { storeId, status: { in: ["APPROVED", "IN_TRANSIT", "RETURNING"] }, OR: [{ fromWarehouseId: locationId }, { toWarehouseId: locationId }] },
        select: { id: true, docNumber: true, status: true, quantity: true, releasedAt: true, product: { select: { name: true } } },
      }),
      prisma.resackJob.findMany({ where: { storeId, locationId, status: "STARTED" }, select: { id: true, docNumber: true, inputQty: true, startedAt: true, inputProduct: { select: { name: true } } } }),
    ]);
    return {
      trips: trips.map((t) => ({ id: t.id, docNumber: t.docNumber, status: t.status, quantity: t.quantity, product: t.product.name, releasedAt: t.releasedAt })),
      resacks: resacks.map((r) => ({ id: r.id, docNumber: r.docNumber, inputQty: r.inputQty, product: r.inputProduct.name, startedAt: r.startedAt })),
    };
  }

  async daily(storeId: string, actor: Actor, input: { date?: string; locationId?: string }) {
    return this.run(async () => {
      const date = input.date || manilaDate(new Date());
      dayRange(date);
      const all = await this.locations(storeId);
      const locs = input.locationId ? all.filter((l) => l.id === input.locationId) : OWNERS.includes(actor.role) ? all : all.filter((l) => l.id === actor.homeLocationId);
      if (locs.length === 0) throw new StepError(invalid("Choose a location"));
      for (const l of locs) {
        const refusal = locationRefusal(actor, l.id);
        if (refusal) throw new StepError(forbidden(refusal));
      }
      const closes = new Map((await prisma.dailyClose.findMany({ where: { storeId, businessDate: date, locationId: { in: locs.map((l) => l.id) } } })).map((c) => [c.locationId, c]));
      type DayTotals = Awaited<ReturnType<RiceReportsService["dayTotals"]>>;
      type Section = DayTotals & {
        location: (typeof locs)[number]; locked: boolean; closedAt: Date | null; cashCountedMinor: number | null; cashVarianceMinor: number | null;
        openHandOffs: Awaited<ReturnType<RiceReportsService["openHandOffs"]>>;
        afterClose: Awaited<ReturnType<RiceReportsService["afterClose"]>> | null;
      };
      const sections: Section[] = [];
      for (const l of locs) {
        const closed = closes.get(l.id);
        const totals = closed ? (closed.totals as unknown as DayTotals) : await this.dayTotals(storeId, l.id, date);
        sections.push({
          location: l, locked: !!closed, closedAt: closed?.closedAt ?? null,
          cashCountedMinor: closed?.cashCountedMinor ?? null, cashVarianceMinor: closed?.cashVarianceMinor ?? null,
          ...totals, openHandOffs: await this.openHandOffs(storeId, l.id),
          afterClose: closed ? await this.afterClose(storeId, l.id, date, closed.closedAt) : null,
        });
      }
      const sum = (f: (s: Section) => number) => sections.reduce((a, s) => a + f(s), 0);
      return {
        date, sections,
        total: {
          salesMinor: sum((s) => s.sales.totalMinor), cashMinor: sum((s) => s.sales.cashMinor), gcashMinor: sum((s) => s.sales.gcashMinor), utangMinor: sum((s) => s.sales.utangMinor),
          grossProfitMinor: sum((s) => s.sales.grossProfitMinor), utangCollectedMinor: sum((s) => s.utang.collectedMinor), writeOffMinor: sum((s) => s.writeOffs.valueMinor),
          resackLossMinor: sum((s) => s.resack.lossValueMinor), countKulangMinor: sum((s) => s.counts.kulangMinor),
        },
      };
    });
  }

  /** Pagsasara: the closing staff count the cash and sign; the day's report locks. */
  async close(storeId: string, actor: Actor, input: { locationId?: string; date?: string; cashCountedMinor?: unknown; closingCountId?: string; note?: string; signatures?: SignatureInput[] }) {
    return this.run(async () => {
      const locationId = input.locationId || actor.homeLocationId;
      const loc = locationId ? await prisma.warehouse.findFirst({ where: { id: locationId, storeId, isActive: true }, select: { id: true, name: true } }) : null;
      if (!loc) throw new StepError(invalid("Choose a location"));
      const refusal = locationRefusal(actor, loc.id);
      if (refusal) throw new StepError(forbidden(refusal));
      const date = input.date || manilaDate(new Date());
      if (date > manilaDate(new Date())) throw new StepError(invalid("That day has not come yet"));
      const counted = input.cashCountedMinor;
      if (typeof counted !== "number" || !Number.isInteger(counted) || counted < 0) throw new StepError(invalid("Enter the cash you counted"));
      const totals = await this.dayTotals(storeId, loc.id, date);
      const handOffs = await this.openHandOffs(storeId, loc.id);
      try {
        return await prisma.$transaction(async (tx) => {
          const row = await tx.dailyClose.create({
            data: {
              storeId, locationId: loc.id, businessDate: date, totals: { ...totals, openHandOffsAtClose: handOffs } as unknown as Prisma.InputJsonValue,
              cashExpectedMinor: totals.cash.expectedMinor, cashCountedMinor: counted, cashVarianceMinor: counted - totals.cash.expectedMinor,
              closingCountId: input.closingCountId ?? null, note: input.note?.trim().slice(0, 300) || null, closedById: actor.userId,
            },
            select: { id: true },
          });
          await captureSignatures(tx, storeId, actor, { documentType: "CLOSE", documentId: row.id, step: "DAY", locationId: loc.id }, input.signatures);
          await requireSignatures(tx, storeId, { documentType: "CLOSE", documentId: row.id, step: "DAY" });
          await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "day.close", entityType: "DailyClose", entityId: row.id, after: { date, locationId: loc.id, cashExpectedMinor: totals.cash.expectedMinor, cashCountedMinor: counted } } });
          return { id: row.id, date, location: loc, cashExpectedMinor: totals.cash.expectedMinor, cashCountedMinor: counted, cashVarianceMinor: counted - totals.cash.expectedMinor, openHandOffs: handOffs };
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new StepError(conflict(`${loc.name} is already closed for ${date}`));
        throw e;
      }
    });
  }

  // ─────────────────────────── Monthly ───────────────────────────

  async monthly(storeId: string, actor: Actor, month: string | undefined) {
    return this.run(async () => {
      this.owner(actor);
      const m = month || manilaDate(new Date()).slice(0, 7);
      const { from, to } = monthRange(m);
      const range = { gte: from, lt: to };
      const [locations, products, orders, resacks, shorts, writeOffs, credit, forReview, levels] = await Promise.all([
        this.locations(storeId),
        prisma.product.findMany({ where: { storeId }, select: productSelect }),
        prisma.order.findMany({
          where: { storeId, status: "COMPLETED", OR: [{ occurredAt: range }, { occurredAt: null, createdAt: range }] },
          select: { sellingLocationId: true, totalMinor: true, items: { select: { productId: true, soldBy: true, quantity: true, grams: true, lineTotalMinor: true, unitCostMinor: true } } },
        }),
        prisma.resackJob.findMany({ where: { storeId, status: "FINISHED", finishedAt: range }, select: { locationId: true, kargadorId: true, inputGrams: true, lossGrams: true, lossValueMinor: true, kargador: { select: { name: true } } } }),
        prisma.stockTransfer.findMany({ where: { storeId, receivedAt: range, shortQty: { gt: 0 } }, select: { toWarehouseId: true, kargadorId: true, shortQty: true, productId: true, kargador: { select: { name: true } } } }),
        prisma.stockWriteOff.findMany({ where: { storeId, createdAt: range }, select: { locationId: true, valueMinor: true } }),
        prisma.creditEntry.findMany({ where: { storeId, createdAt: { lt: to } }, select: { storeCustomerId: true, type: true, amountMinor: true, createdAt: true } }),
        prisma.product.count({ where: { storeId, reviewStatus: "FOR_REVIEW" } }),
        prisma.stockLevel.findMany({ where: { storeId }, select: { productId: true, quantityOnHand: true } }),
      ]);
      const byProduct = new Map(products.map((p) => [p.id, p]));
      const perLoc = new Map(locations.map((l) => [l.id, { location: l, salesMinor: 0, costMinor: 0, grams: 0, orders: 0, resackGramsIn: 0, resackLossGrams: 0, resackLossMinor: 0, transitShortGrams: 0, writeOffMinor: 0 }]));
      const perVariety = new Map<string, { grams: number; salesMinor: number; costMinor: number }>();
      let soldCost = 0;
      for (const o of orders) {
        const L = o.sellingLocationId ? perLoc.get(o.sellingLocationId) : undefined;
        if (L) { L.salesMinor += o.totalMinor; L.orders++; }
        for (const i of o.items) {
          const p = i.productId ? byProduct.get(i.productId) : undefined;
          if (!p) continue;
          const c = lineCost(i, p.costMinor, isLooseP(p));
          const g = lineGrams(i, p.stockBaseUnit === "g" ? p.stockBaseQuantity : null);
          soldCost += c;
          if (L) { L.costMinor += c; L.grams += g; }
          const v = perVariety.get(varietyOf(p)) ?? { grams: 0, salesMinor: 0, costMinor: 0 };
          v.grams += g; v.salesMinor += i.lineTotalMinor; v.costMinor += c;
          perVariety.set(varietyOf(p), v);
        }
      }
      const perKargador = new Map<string, { name: string; resackGramsIn: number; resackLossGrams: number; transitShortGrams: number }>();
      const kg = (id: string | null, name: string | undefined) => {
        if (!id) return null;
        const k = perKargador.get(id) ?? { name: name ?? "", resackGramsIn: 0, resackLossGrams: 0, transitShortGrams: 0 };
        perKargador.set(id, k);
        return k;
      };
      for (const r of resacks) {
        const L = perLoc.get(r.locationId);
        if (L) { L.resackGramsIn += r.inputGrams; L.resackLossGrams += r.lossGrams ?? 0; L.resackLossMinor += r.lossValueMinor ?? 0; }
        const k = kg(r.kargadorId, r.kargador?.name);
        if (k) { k.resackGramsIn += r.inputGrams; k.resackLossGrams += r.lossGrams ?? 0; }
      }
      for (const s of shorts) {
        const p = byProduct.get(s.productId);
        const g = (s.shortQty ?? 0) * (p?.stockBaseUnit === "g" ? p.stockBaseQuantity ?? 0 : 0);
        const L = perLoc.get(s.toWarehouseId);
        if (L) L.transitShortGrams += g;
        const k = kg(s.kargadorId, s.kargador?.name);
        if (k) k.transitShortGrams += g;
      }
      for (const w of writeOffs) { const L = perLoc.get(w.locationId); if (L) L.writeOffMinor += w.valueMinor; }
      // Utang aging as of the end of the month (payments settle the oldest utang first).
      const byCustomer = new Map<string, { type: string; amountMinor: number; createdAt: Date }[]>();
      for (const c of credit) byCustomer.set(c.storeCustomerId, [...(byCustomer.get(c.storeCustomerId) ?? []), c]);
      const asOf = new Date(Math.min(to.getTime(), Date.now()));
      const agingTotal = { d0_30: 0, d31_60: 0, d60plus: 0 };
      for (const entries of byCustomer.values()) {
        const a = aging(entries, asOf);
        agingTotal.d0_30 += a.d0_30; agingTotal.d31_60 += a.d31_60; agingTotal.d60plus += a.d60plus;
      }
      const stockValue = levels.reduce((s, l) => { const p = byProduct.get(l.productId); return s + (p ? costValue(p, Math.max(0, l.quantityOnHand)) : 0); }, 0);
      return {
        month: m,
        locations: [...perLoc.values()].map((L) => ({
          ...L, grossProfitMinor: L.salesMinor - L.costMinor, resackLossPct: pct(L.resackLossGrams, L.resackGramsIn),
        })),
        varieties: [...perVariety.entries()].map(([variety, v]) => ({ variety, ...v, grossProfitMinor: v.salesMinor - v.costMinor })).sort((a, b) => b.grams - a.grams),
        kargadorLoss: [...perKargador.entries()].map(([id, k]) => ({ kargadorId: id, ...k, resackLossPct: pct(k.resackLossGrams, k.resackGramsIn) })),
        utangAging: agingTotal,
        manualItemsForReview: forReview,
        turnover: { soldCostMinor: soldCost, stockValueMinor: stockValue, ratio: stockValue > 0 ? Math.round((soldCost * 100) / stockValue) / 100 : null },
        kargadorPay: await this.payRows(storeId, from, to),
      };
    });
  }

  // ─────────────────────────── Kargador pay ───────────────────────────

  private async payRows(storeId: string, from: Date, to: Date) {
    const sigs = await prisma.signature.findMany({
      where: { storeId, kargadorId: { not: null }, createdAt: { gte: from, lt: to } },
      select: { kargadorId: true, documentType: true, documentId: true, step: true, createdAt: true, kargador: { select: { name: true } }, location: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    });
    const docs = await this.docNumbers(storeId, sigs.map((s) => ({ type: s.documentType, id: s.documentId })));
    const per = new Map<string, { name: string; transactions: { date: string; kind: string; docNumber: string; location: string | null }[] }>();
    const seen = new Set<string>();
    for (const s of sigs) {
      const key = `${s.kargadorId}:${s.documentType}:${s.documentId}:${s.step}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = per.get(s.kargadorId!) ?? { name: s.kargador?.name ?? "", transactions: [] };
      row.transactions.push({ date: manilaDate(s.createdAt), kind: `${s.documentType}:${s.step}`, docNumber: docs.get(`${s.documentType}:${s.documentId}`) ?? s.documentId, location: s.location?.name ?? null });
      per.set(s.kargadorId!, row);
    }
    return [...per.entries()].map(([kargadorId, r]) => ({ kargadorId, name: r.name, count: r.transactions.length, transactions: r.transactions })).sort((a, b) => b.count - a.count);
  }

  async kargadorPay(storeId: string, actor: Actor, month: string | undefined) {
    return this.run(async () => {
      this.owner(actor);
      const m = month || manilaDate(new Date()).slice(0, 7);
      const { from, to } = monthRange(m);
      return { month: m, kargadors: await this.payRows(storeId, from, to) };
    });
  }

  /** Document numbers for a list of (type, id) — for trails and pay sheets. */
  private async docNumbers(storeId: string, refs: { type: string; id: string }[]): Promise<Map<string, string>> {
    const ids = (t: string[]) => [...new Set(refs.filter((r) => t.includes(r.type)).map((r) => r.id))];
    const [trips, resacks, counts, wos, rets, ins, orders] = await Promise.all([
      prisma.stockTransfer.findMany({ where: { storeId, id: { in: ids(["TRANSFER", "RELEASE"]) } }, select: { id: true, docNumber: true } }),
      prisma.resackJob.findMany({ where: { storeId, id: { in: ids(["RESACK"]) } }, select: { id: true, docNumber: true } }),
      prisma.stockCount.findMany({ where: { storeId, id: { in: ids(["COUNT"]) } }, select: { id: true, docNumber: true } }),
      prisma.stockWriteOff.findMany({ where: { storeId, id: { in: ids(["WRITE_OFF"]) } }, select: { id: true, docNumber: true } }),
      prisma.stockReturn.findMany({ where: { storeId, id: { in: ids(["RETURN"]) } }, select: { id: true, docNumber: true } }),
      prisma.stockIn.findMany({ where: { storeId, id: { in: ids(["STOCK_IN"]) } }, select: { id: true, docNumber: true } }),
      prisma.order.findMany({ where: { storeId, id: { in: ids(["SALE", "ORDER", "PAPER_SLIP"]) } }, select: { id: true, orderNumber: true } }),
    ]);
    const out = new Map<string, string>();
    for (const t of trips) { out.set(`TRANSFER:${t.id}`, t.docNumber ?? t.id); out.set(`RELEASE:${t.id}`, t.docNumber ?? t.id); }
    for (const r of resacks) out.set(`RESACK:${r.id}`, r.docNumber);
    for (const c of counts) out.set(`COUNT:${c.id}`, c.docNumber);
    for (const w of wos) out.set(`WRITE_OFF:${w.id}`, w.docNumber);
    for (const r of rets) out.set(`RETURN:${r.id}`, r.docNumber);
    for (const i of ins) out.set(`STOCK_IN:${i.id}`, i.docNumber);
    for (const o of orders) { out.set(`SALE:${o.id}`, o.orderNumber); out.set(`ORDER:${o.id}`, o.orderNumber); out.set(`PAPER_SLIP:${o.id}`, o.orderNumber); }
    return out;
  }

  // ─────────────────────────── Balance (kulang ranking) ───────────────────────────

  /** Kulang found by counts in a period, ranked by pesos, each with who touched the item since its previous count. */
  async balanceReport(storeId: string, actor: Actor, input: { from?: string; to?: string; locationId?: string }) {
    return this.run(async () => {
      this.owner(actor);
      const to = input.to ? dayRange(input.to).to : new Date();
      const from = input.from ? dayRange(input.from).from : new Date(to.getTime() - 31 * 86_400_000);
      const lines = await prisma.stockCountLine.findMany({
        where: { storeId, varianceQty: { lt: 0 }, postedQty: { not: null }, count: { status: "APPROVED", decidedAt: { gte: from, lt: to }, ...(input.locationId ? { locationId: input.locationId } : {}) } },
        include: { product: { select: productSelect }, count: { select: { id: true, docNumber: true, locationId: true, location: { select: { name: true } } } } },
        orderBy: { varianceValueMinor: "asc" }, take: 50,
      });
      const out = [];
      for (const l of lines) {
        const prev = await prisma.stockCountLine.findFirst({
          where: { storeId, productId: l.productId, countedAt: { lt: l.countedAt! }, postedQty: { not: null }, count: { locationId: l.count.locationId, status: "APPROVED" } },
          orderBy: { countedAt: "desc" }, select: { countedAt: true, count: { select: { docNumber: true } } },
        });
        const moves = await prisma.stockMovement.findMany({
          where: { storeId, productId: l.productId, warehouseId: l.count.locationId, createdAt: { ...(prev ? { gt: prev.countedAt! } : {}), lte: l.countedAt! }, type: { notIn: RESERVED_ONLY } },
          select: { type: true, delta: true, documentType: true, documentId: true, createdBy: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        });
        const people = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.createdBy ?? ""))] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email]));
        const kargadorSigs = await prisma.signature.findMany({ where: { storeId, documentId: { in: [...new Set(moves.map((m) => m.documentId ?? ""))] }, kargadorId: { not: null } }, select: { documentId: true, signerName: true } });
        const docs = await this.docNumbers(storeId, moves.filter((m) => m.documentType && m.documentId).map((m) => ({ type: m.documentType!, id: m.documentId! })));
        out.push({
          product: l.product.name, loose: isLooseP(l.product), location: l.count.location.name, countDoc: l.count.docNumber, countedAt: l.countedAt,
          kulangQty: -(l.varianceQty ?? 0), kulangValueMinor: -(l.varianceValueMinor ?? 0), since: prev ? { docNumber: prev.count.docNumber, countedAt: prev.countedAt } : null,
          people: [...new Set(moves.map((m) => (m.createdBy ? people.get(m.createdBy) : null)).filter(Boolean))],
          kargadors: [...new Set(kargadorSigs.map((s) => s.signerName))],
          trail: moves.map((m) => ({ type: m.type, delta: m.delta, docNumber: m.documentType && m.documentId ? docs.get(`${m.documentType}:${m.documentId}`) ?? null : null, by: m.createdBy ? people.get(m.createdBy) ?? null : null, at: m.createdAt })),
        });
      }
      return { from, to, items: out };
    });
  }

  // ─────────────────────────── Stock book: does the ledger agree with the shelf? ───────────────────────────

  /**
   * Read-only. For every product at every location (or one): the stock on hand against what the
   * ledger says. Only the ones that disagree are listed, each with the exact ledger row where the
   * chain broke, so a case like "sold from Store 2 but Store 2 shows out of stock" can be traced.
   */
  /** How this store counts cost: SHARED (one cost per product) or PER_LOCATION (each shelf its own). Owner only. */
  async getCostMode(storeId: string, actor: Actor) {
    return this.run(async () => {
      this.owner(actor);
      return { costMode: await costModeOf(prisma, storeId) };
    });
  }

  async setCostMode(storeId: string, actor: Actor, mode: unknown) {
    return this.run(async () => {
      this.owner(actor);
      if (mode !== "SHARED" && mode !== "PER_LOCATION") throw new StepError(invalid("Choose one cost for all locations, or a cost for each location"));
      const before = await costModeOf(prisma, storeId);
      if (before !== mode) {
        await prisma.storeSettings.upsert({ where: { storeId }, create: { storeId, costMode: mode }, update: { costMode: mode } });
        await prisma.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "settings.cost_mode", entityType: "StoreSettings", entityId: storeId, before: { costMode: before }, after: { costMode: mode } } });
      }
      return { costMode: mode as string };
    });
  }

  async stockBookCheck(storeId: string, actor: Actor, input: { locationId?: string }) {
    return this.run(async () => {
      this.owner(actor);
      const locFilter = input.locationId ? { warehouseId: input.locationId } : { warehouseId: { not: null } };
      const [locations, products, levels, moves] = await Promise.all([
        this.locations(storeId),
        prisma.product.findMany({ where: { storeId }, select: productSelect }),
        prisma.stockLevel.findMany({ where: { storeId, ...locFilter }, select: { productId: true, warehouseId: true, quantityOnHand: true, costMinor: true } }),
        prisma.stockMovement.findMany({
          where: { storeId, ...locFilter, type: { notIn: RESERVED_ONLY } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, productId: true, warehouseId: true, type: true, delta: true, balanceAfter: true, documentType: true, documentId: true, createdAt: true },
        }),
      ]);
      const byProduct = new Map(products.map((p) => [p.id, p]));
      const locName = new Map(locations.map((l) => [l.id, l.name]));
      const key = (productId: string, warehouseId: string) => `${productId}|${warehouseId}`;
      const history = new Map<string, LedgerRow[]>();
      for (const m of moves) {
        const k = key(m.productId, m.warehouseId!);
        const list = history.get(k) ?? [];
        list.push({ id: m.id, type: m.type, delta: m.delta, balanceAfter: m.balanceAfter, documentType: m.documentType, documentId: m.documentId, createdAt: m.createdAt });
        history.set(k, list);
      }
      const onHand = new Map<string, number>(levels.map((l): [string, number] => [key(l.productId, l.warehouseId!), l.quantityOnHand]));
      const keys = new Set<string>([...history.keys(), ...onHand.keys()]);
      const found: { productId: string; locationId: string; check: ChainCheck }[] = [];
      let checked = 0;
      for (const k of keys) {
        const [productId, locationId] = k.split("|") as [string, string];
        if (!byProduct.has(productId) || !locName.has(locationId)) continue;
        checked += 1;
        const check = checkChain(history.get(k) ?? [], onHand.get(k) ?? 0, []);
        if (check.status === "off" || check.status === "no_ledger") found.push({ productId, locationId, check });
      }
      found.sort((a, b) => Math.abs(b.check.difference) - Math.abs(a.check.difference));
      const shown = found.slice(0, 200);
      const docs = await this.docNumbers(storeId, shown.flatMap((f) => f.check.breaks.slice(0, 3)).filter((b) => b.documentType && b.documentId).map((b) => ({ type: b.documentType!, id: b.documentId! })));
      return {
        checked,
        problems: found.length,
        items: shown.map((f) => {
          const p = byProduct.get(f.productId)!;
          return {
            productId: f.productId, name: p.name, loose: isLooseP(p), locationId: f.locationId, location: locName.get(f.locationId) ?? "",
            status: f.check.status, onHand: f.check.onHand, ledgerBalance: f.check.ledgerBalance, difference: f.check.difference,
            breaks: f.check.breaks.slice(0, 3).map((b) => ({ type: b.type, docNumber: b.documentType && b.documentId ? docs.get(`${b.documentType}:${b.documentId}`) ?? null : null, at: b.at, expected: b.expected, actual: b.actual, gap: b.gap })),
          };
        }),
      };
    });
  }

  /**
   * Read-only. The stock book for ONE product: every ledger row (newest first) with the running
   * balance, the document number, who did it, and the price/cost where the document keeps one,
   * plus opening / in / out / closing per location for the chosen dates.
   */
  async stockBookPage(storeId: string, actor: Actor, input: { productId?: string; locationId?: string; from?: string; to?: string }) {
    return this.run(async () => {
      this.owner(actor);
      if (!input.productId) throw new StepError(invalid("Pick a product"));
      const product = await prisma.product.findFirst({ where: { id: input.productId, storeId }, select: productSelect });
      if (!product) throw new StepError(invalid("Product not found"));
      const to = input.to ? dayRange(input.to).to : new Date(Date.now() + 1_000);
      const from = input.from ? dayRange(input.from).from : new Date(to.getTime() - 31 * 86_400_000);
      const moves = await prisma.stockMovement.findMany({
        where: { storeId, productId: product.id, warehouseId: input.locationId ? input.locationId : { not: null }, type: { notIn: RESERVED_ONLY } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, warehouseId: true, type: true, delta: true, balanceAfter: true, documentType: true, documentId: true, createdAt: true, createdBy: true },
      });
      const locations = await this.locations(storeId);
      const levels = await prisma.stockLevel.findMany({ where: { storeId, productId: product.id, warehouseId: { not: null } }, select: { productId: true, warehouseId: true, costMinor: true } });
      const locName = new Map(locations.map((l) => [l.id, l.name]));
      const byLoc = new Map<string, LedgerRow[]>();
      for (const m of moves) {
        const list = byLoc.get(m.warehouseId!) ?? [];
        list.push({ id: m.id, type: m.type, delta: m.delta, balanceAfter: m.balanceAfter, documentType: m.documentType, documentId: m.documentId, createdAt: m.createdAt });
        byLoc.set(m.warehouseId!, list);
      }
      // Money, per location: what sold here in these dates (completed sales only), at the cost frozen with each sale,
      // and what the stock left on the shelf is worth at the product's current cost (the main store's cost).
      const soldLines = await prisma.orderItem.findMany({
        where: { storeId, productId: product.id, order: { status: "COMPLETED", sellingLocationId: input.locationId ? input.locationId : { not: null }, OR: [{ occurredAt: { gte: from, lt: to } }, { occurredAt: null, createdAt: { gte: from, lt: to } }] } },
        select: { soldBy: true, quantity: true, lineTotalMinor: true, unitCostMinor: true, order: { select: { sellingLocationId: true } } },
      });
      const money = new Map<string, { salesMinor: number; costOfSoldMinor: number; soldQty: number }>();
      for (const l of soldLines) {
        const id = l.order.sellingLocationId;
        if (!id) continue;
        const m = money.get(id) ?? { salesMinor: 0, costOfSoldMinor: 0, soldQty: 0 };
        if (isLooseP(product) ? true : l.soldBy === "PIECE" || l.soldBy === null) m.soldQty += l.quantity;
        m.salesMinor += l.lineTotalMinor;
        m.costOfSoldMinor += lineCost(l, product.costMinor ?? 0, isLooseP(product));
        money.set(id, m);
      }
      const costMode = await costModeOf(prisma, storeId);
      // Each location's own cost when the store counts per location; otherwise the one product cost.
      const unitCostAt = (locId: string) => effectiveCost(costMode, levels.find((lv) => lv.productId === product.id && lv.warehouseId === locId)?.costMinor, product.costMinor ?? 0);
      const worth = (q: number | null, unitCost: number) => (q === null ? null : isLooseP(product) ? Math.round((q * unitCost) / 1000) : q * unitCost);
      const locIds = new Set<string>([...byLoc.keys(), ...money.keys()]);
      const totals = [...locIds].filter((id) => locName.has(id)).map((id) => {
        const t = periodTotals(byLoc.get(id) ?? [], from, to);
        const m = money.get(id) ?? { salesMinor: 0, costOfSoldMinor: 0, soldQty: 0 };
        const profitMinor = m.salesMinor - m.costOfSoldMinor;
        // Sold here, but the rice came off another location's shelf (a release for the sale), so this shelf has no sale row for it.
        const soldFromOtherQty = Math.max(0, m.soldQty - t.byBucket.sale.outQty);
        return {
          locationId: id, location: locName.get(id) ?? "", ...t, soldQty: m.soldQty, soldFromOtherQty,
          unitCostMinor: unitCostAt(id), stockValueMinor: worth(t.closing, unitCostAt(id)), salesMinor: m.salesMinor, costOfSoldMinor: m.costOfSoldMinor, profitMinor,
          profitPct: m.salesMinor > 0 ? Math.round((profitMinor / m.salesMinor) * 1000) / 10 : null,
        };
      });
      const inRange = moves.filter((m) => m.createdAt >= from && m.createdAt < to && locName.has(m.warehouseId!));
      const shown = inRange.slice(-500).reverse();
      const withDoc = shown.filter((m) => m.documentType && m.documentId) as (typeof shown[number] & { documentType: string; documentId: string })[];
      const tripIds = [...new Set(withDoc.filter((m) => m.documentType === "RELEASE" || m.documentType === "TRANSFER").map((m) => m.documentId))];
      const trips = tripIds.length
        ? await prisma.stockTransfer.findMany({ where: { storeId, id: { in: tripIds } }, select: { id: true, kind: true, order: { select: { orderNumber: true, sellingLocation: { select: { name: true } } } } } })
        : [];
      const tripNote = new Map(trips.map((t) => [t.id, t.order ? `for sale ${t.order.orderNumber}${t.order.sellingLocation ? ` at ${t.order.sellingLocation.name}` : ""}` : null]));
      const [docs, people, saleLines, inLines] = await Promise.all([
        this.docNumbers(storeId, withDoc.map((m) => ({ type: m.documentType, id: m.documentId }))),
        prisma.user.findMany({ where: { id: { in: [...new Set(shown.map((m) => m.createdBy ?? ""))] } }, select: { id: true, name: true, email: true } }),
        prisma.orderItem.findMany({ where: { storeId, productId: product.id, orderId: { in: [...new Set(withDoc.filter((m) => ["SALE", "ORDER", "PAPER_SLIP"].includes(m.documentType)).map((m) => m.documentId))] } }, select: { orderId: true, unitPriceMinor: true, unitCostMinor: true } }),
        prisma.stockInLine.findMany({ where: { storeId, productId: product.id, stockInId: { in: [...new Set(withDoc.filter((m) => m.documentType === "STOCK_IN").map((m) => m.documentId))] } }, select: { stockInId: true, unitCostMinor: true } }),
      ]);
      const who = new Map(people.map((u) => [u.id, u.name || u.email]));
      const sale = new Map(saleLines.map((l) => [l.orderId, l]));
      const stockIn = new Map(inLines.map((l) => [l.stockInId, l]));
      return {
        product: { id: product.id, name: product.name, loose: isLooseP(product), currentCostMinor: product.costMinor ?? null, costMode },
        from, to, truncated: inRange.length > shown.length,
        totals,
        rows: shown.map((m) => {
          const sl = m.documentId ? sale.get(m.documentId) : undefined;
          const il = m.documentId ? stockIn.get(m.documentId) : undefined;
          return {
            id: m.id, at: m.createdAt, locationId: m.warehouseId, location: locName.get(m.warehouseId!) ?? "", type: m.type, documentType: m.documentType,
            docNumber: m.documentType && m.documentId ? docs.get(`${m.documentType}:${m.documentId}`) ?? null : null,
            note: m.documentId ? tripNote.get(m.documentId) ?? null : null,
            delta: m.delta, balanceAfter: m.balanceAfter, by: m.createdBy ? who.get(m.createdBy) ?? null : null,
            unitPriceMinor: sl?.unitPriceMinor ?? null, unitCostMinor: sl?.unitCostMinor ?? il?.unitCostMinor ?? null,
          };
        }),
      };
    });
  }

  // ─────────────────────────── Trace (Hanapin) ───────────────────────────

  async trace(storeId: string, actor: Actor, q: string | undefined) {
    return this.run(async () => {
      this.owner(actor);
      const text = (q ?? "").trim();
      if (text.length < 2) throw new StepError(invalid("Enter what to search for (2+ letters)"));
      const doc = text.toUpperCase();
      const [trips, resacks, counts, wos, rets, ins, orders] = await Promise.all([
        prisma.stockTransfer.findMany({ where: { storeId, docNumber: doc }, select: { id: true, docNumber: true } }),
        prisma.resackJob.findMany({ where: { storeId, docNumber: doc }, select: { id: true, docNumber: true } }),
        prisma.stockCount.findMany({ where: { storeId, docNumber: doc }, select: { id: true, docNumber: true } }),
        prisma.stockWriteOff.findMany({ where: { storeId, docNumber: doc }, select: { id: true, docNumber: true } }),
        prisma.stockReturn.findMany({ where: { storeId, docNumber: doc }, select: { id: true, docNumber: true } }),
        prisma.stockIn.findMany({ where: { storeId, docNumber: doc }, select: { id: true, docNumber: true } }),
        prisma.order.findMany({ where: { storeId, orderNumber: doc }, select: { id: true, orderNumber: true } }),
      ]);
      const found: { type: string; id: string; docNumber: string }[] = [
        ...trips.map((t) => ({ type: "RELEASE", id: t.id, docNumber: t.docNumber ?? t.id })),
        ...resacks.map((r) => ({ type: "RESACK", id: r.id, docNumber: r.docNumber })),
        ...counts.map((c) => ({ type: "COUNT", id: c.id, docNumber: c.docNumber })),
        ...wos.map((w) => ({ type: "WRITE_OFF", id: w.id, docNumber: w.docNumber })),
        ...rets.map((r) => ({ type: "RETURN", id: r.id, docNumber: r.docNumber })),
        ...ins.map((i) => ({ type: "STOCK_IN", id: i.id, docNumber: i.docNumber })),
        ...orders.map((o) => ({ type: "SALE", id: o.id, docNumber: o.orderNumber })),
      ];
      if (found.length === 0) {
        // Not a document number: a customer, kargador, staff or product → their recent documents.
        const like = { contains: text, mode: "insensitive" as const };
        const [custOrders, kargadorSigs, staff, products] = await Promise.all([
          prisma.order.findMany({ where: { storeId, customerName: like }, select: { id: true, orderNumber: true }, orderBy: { createdAt: "desc" }, take: 10 }),
          prisma.signature.findMany({ where: { storeId, kargadorId: { not: null }, signerName: like }, select: { documentType: true, documentId: true }, orderBy: { createdAt: "desc" }, take: 20 }),
          prisma.userStore.findMany({ where: { storeId, user: { OR: [{ name: like }, { email: like }] } }, select: { userId: true } }),
          prisma.product.findMany({ where: { storeId, name: like }, select: { id: true }, take: 5 }),
        ]);
        found.push(...custOrders.map((o) => ({ type: "SALE", id: o.id, docNumber: o.orderNumber })));
        const extra = [...kargadorSigs.map((s) => ({ type: s.documentType, id: s.documentId }))];
        if (staff.length) {
          const mv = await prisma.stockMovement.findMany({ where: { storeId, createdBy: { in: staff.map((s) => s.userId) }, documentId: { not: null } }, select: { documentType: true, documentId: true }, orderBy: { createdAt: "desc" }, take: 20 });
          extra.push(...mv.map((m) => ({ type: m.documentType ?? "", id: m.documentId! })));
        }
        if (products.length) {
          const mv = await prisma.stockMovement.findMany({ where: { storeId, productId: { in: products.map((p) => p.id) }, documentId: { not: null } }, select: { documentType: true, documentId: true }, orderBy: { createdAt: "desc" }, take: 20 });
          extra.push(...mv.map((m) => ({ type: m.documentType ?? "", id: m.documentId! })));
        }
        const docs = await this.docNumbers(storeId, extra);
        for (const e of extra) {
          const n = docs.get(`${e.type}:${e.id}`);
          if (n && !found.some((f) => f.id === e.id)) found.push({ type: e.type === "ORDER" || e.type === "PAPER_SLIP" ? "SALE" : e.type, id: e.id, docNumber: n });
        }
      }
      const unique = found.filter((f, i) => found.findIndex((g) => g.id === f.id) === i).slice(0, 15);
      const trails = [];
      for (const f of unique) {
        const [sigs, moves] = await Promise.all([
          prisma.signature.findMany({ where: { storeId, documentId: f.id }, select: { documentType: true, step: true, signerKind: true, signerName: true, createdAt: true, location: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
          prisma.stockMovement.findMany({ where: { storeId, documentId: f.id }, select: { type: true, delta: true, createdAt: true, createdBy: true, product: { select: { name: true } }, warehouse: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
        ]);
        const people = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.createdBy ?? ""))] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email]));
        trails.push({
          ...f,
          signatures: sigs.map((s) => ({ step: `${s.documentType}:${s.step}`, signer: s.signerName, kind: s.signerKind, at: s.createdAt, location: s.location?.name ?? null })),
          movements: moves.map((m) => ({ type: m.type, delta: m.delta, product: m.product?.name ?? null, location: m.warehouse?.name ?? null, by: m.createdBy ? people.get(m.createdBy) ?? null : null, at: m.createdAt })),
        });
      }
      return { q: text, results: trails };
    });
  }

  // ─────────────────────────── Alerts ───────────────────────────

  async alerts(storeId: string, actor: Actor) {
    return this.run(async () => {
      this.owner(actor);
      const now = new Date();
      const today = dayRange(manilaDate(now));
      const [approvals, bigKulang, lateReleases, oldResacks, customers, settings, drafts, ledger] = await Promise.all([
        prisma.approvalRequest.findMany({ where: { storeId, status: "PENDING" }, select: { id: true, kind: true, summary: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: 20 }),
        prisma.stockCount.findMany({ where: { storeId, status: "APPROVED", kulangValueMinor: { gt: 50_000 }, decidedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, select: { docNumber: true, kulangValueMinor: true, location: { select: { name: true } } } }),
        prisma.stockTransfer.findMany({ where: { storeId, kind: "ORDER_RELEASE", status: "IN_TRANSIT", releasedAt: { lt: new Date(now.getTime() - 4 * 3_600_000) } }, select: { docNumber: true, releasedAt: true, product: { select: { name: true } }, kargador: { select: { name: true } } } }),
        prisma.resackJob.findMany({ where: { storeId, status: "STARTED", startedAt: { lt: today.from } }, select: { docNumber: true, startedAt: true, location: { select: { name: true } } } }),
        prisma.storeCustomer.findMany({ where: { storeId, creditBalanceMinor: { gt: 0 } }, select: { id: true, creditBalanceMinor: true, creditLimitMinor: true, customer: { select: { name: true } }, credit: { select: { type: true, amountMinor: true, createdAt: true } } } }),
        prisma.storeSettings.findUnique({ where: { storeId }, select: { creditLimitMinor: true } }),
        prisma.flowDraft.findMany({ where: { storeId, status: "OPEN" }, select: { id: true, flow: true, updatedAt: true, locationId: true } }),
        prisma.$queryRaw<{ productId: string; warehouseId: string; onHand: number; ledger: number }[]>`
          SELECT l."productId", l."warehouseId", l."quantityOnHand" AS "onHand", COALESCE(SUM(m.delta) FILTER (WHERE m.type NOT IN ('RESERVE','RELEASE_RESERVATION')), 0)::int AS "ledger"
            FROM "StockLevel" l
            LEFT JOIN "StockMovement" m ON m."storeId" = l."storeId" AND m."productId" = l."productId" AND m."warehouseId" = l."warehouseId"
           WHERE l."storeId" = ${storeId} AND l."warehouseId" IS NOT NULL
           GROUP BY l."productId", l."warehouseId", l."quantityOnHand"
          HAVING l."quantityOnHand" <> COALESCE(SUM(m.delta) FILTER (WHERE m.type NOT IN ('RESERVE','RELEASE_RESERVATION')), 0)`,
      ]);
      const utang = customers.map((c) => {
        const limit = c.creditLimitMinor > 0 ? c.creditLimitMinor : settings?.creditLimitMinor ?? 0;
        const a = aging(c.credit, now);
        return { id: c.id, name: c.customer.name, balanceMinor: c.creditBalanceMinor, limitMinor: limit, overLimit: limit > 0 && c.creditBalanceMinor > limit, oldestDays: a.oldestDays };
      }).filter((c) => c.overLimit || c.oldestDays > 60);
      return {
        approvals,
        bigKulang: bigKulang.map((c) => ({ docNumber: c.docNumber, kulangValueMinor: c.kulangValueMinor, location: c.location.name })),
        lateReleases: lateReleases.map((t) => ({ docNumber: t.docNumber, releasedAt: t.releasedAt, product: t.product.name, kargador: t.kargador?.name ?? null })),
        unfinishedResacks: oldResacks.map((r) => ({ docNumber: r.docNumber, startedAt: r.startedAt, location: r.location.name })),
        utang,
        staleDrafts: drafts.filter((d) => isDraftStale(d.updatedAt, now)).length,
        ledgerMismatch: ledger.length,
        count: approvals.length + bigKulang.length + lateReleases.length + oldResacks.length + utang.length + (ledger.length ? 1 : 0),
      };
    });
  }
}
