// Rice Ops M8 — Bilangin (counts), the balance, and Manual na bawas (write-offs).
//
//   Any role can count (staff at their own location only). A list count (all items, or one kind
//   of rice, or items not counted lately, or items picked) is counted WITHOUT seeing the
//   system's numbers (blind, unless the owner/manager asks to see them); each line keeps what
//   the system had at the moment it was counted, so sales during the count never show as
//   kulang. The counter submits and signs and the adjustments post at once as "Bilang CNT-…"
//   (no owner approval; the owner sees what was found afterwards). A list count may leave
//   items uncounted: those stay as they are. Quick count (one item) and the closing top-5
//   post at once too; the closing top-5 must be counted in full.
//   Every difference gets a reason (a label only: it posts nothing by itself; "Don't know" is
//   always allowed). Before submitting, the counter sees the differences (the "check" step),
//   may count an item again (the first number is kept) and picks the reasons.
//   Balance: expected = last count + every movement since; it must equal the system's shelf.
//   Write-off: reason, optional photo, staff signs; the stock moves; over 1% → the owner.

import { chargeCountShort, consignmentMain } from "../payable/charges.js";
import { autoResackFromCount } from "../payable/count-resack.js";
import type { ApiError } from "@sam-store/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { adjustForCount, InsufficientStockError, releaseForTrip, type TripLeg } from "../domain/movements.js";
import { varietyOf } from "../domain/resack.js";
import { planOpenedSacks } from "../domain/count-resack.js";
import { accStat, flagText, needsLook, REPEAT_DAYS, suggestList, suggestText, weeklyTrend, type AccLine, type LookCount } from "../domain/count-looks.js";
import { asksRecount, checkReason, cleanNote, missingReasons, missingReasonsMessage, reasonsFor, REASON_LABEL, type CountReason } from "../domain/count-reasons.js";
import { balanceOf, costValue, countedUnits, CountError, gramsIn, isLooseP, lineResult, verdict, WRITE_OFF_LABEL, writeOffCheck } from "../domain/counting.js";
import { formatKilos } from "../domain/weight.js";
import {
  captureSignatures, locationRefusal, nextDocNumber, registerApprovalHandler, requestApproval, requireSignatures, signatureErrorResult,
  type Actor, type SignatureInput,
} from "../people/people.service.js";
import { txOptions } from "../persistence/tx-options.js";

export type CountResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
type Tx = Prisma.TransactionClient;

class StepError extends Error {
  constructor(readonly result: { ok: false; error: ApiError }) {
    super("count step refused");
  }
}
const invalid = (m: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [m] } });
const conflict = (m: string) => ({ ok: false as const, error: { type: "conflict" as const, message: m } });
const forbidden = (m: string) => ({ ok: false as const, error: { type: "forbidden" as const, message: m } });
const notFound = (m = "Count not found") => ({ ok: false as const, error: { type: "not_found" as const, message: m } });

const OWNERS = ["OWNER", "MANAGER", "STORE_OWNER", "PLATFORM_ADMIN"];
const productSelect = { id: true, name: true, stockBaseUnit: true, stockBaseQuantity: true, costMinor: true, variety: true } as const;
type P = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

interface ReportLine {
  productId: string; name: string; loose: boolean; countedQty: number; expectedQty: number; firstCountedQty: number | null;
  varianceQty: number; varianceValueMinor: number; explainedQty: number; verdict: string; reason: string | null; reasonLabel: string | null; note: string | null; countedBy: string | null;
  since: { from: { docNumber: string; countedQty: number; countedAt: Date } | null; buckets: Record<string, number>; ledgerShouldBe: number } | null;
}
interface ReportDifference {
  docNumber: string; postedAt: Date | null; location: string; item: string; loose: boolean; countedQty: number | null; expectedQty: number | null; varianceQty: number;
  varianceValueMinor: number; reason: string | null; reasonLabel: string | null; note: string | null; countedBy: string | null;
}

const qtyText = (p: P, qty: number) => (isLooseP(p) ? formatKilos(qty) : `${qty}`);

/** Post every counted line's difference as COUNT_ADJUST, inside the caller's transaction. */
async function postCount(tx: Tx, storeId: string, countId: string, decidedById: string, opts: { resackVarieties?: string[] } = {}) {
  const count = await tx.stockCount.findUniqueOrThrow({ where: { id: countId }, include: { lines: { include: { product: { select: productSelect } } } } });
  // A consignment store opens sacks without recording it: record the resack first, then post only what is left over.
  const opened = await autoResackFromCount(tx, { storeId, locationId: count.locationId, countId: count.id, countDoc: count.docNumber, actorId: decidedById, lines: count.lines, varieties: opts.resackVarieties });
  const posted = new Map<string, number>();
  for (const l of count.lines) {
    if (l.countedQty === null || l.expectedQty === null) continue;
    const delta = l.countedQty - l.expectedQty - (opened.get(l.productId) ?? 0);
    posted.set(l.productId, delta);
    if (delta !== 0) {
      const why = l.reason ? REASON_LABEL[l.reason as CountReason] : undefined;
      const leg: TripLeg = { storeId, productId: l.productId, warehouseId: count.locationId, actorId: decidedById, documentType: "COUNT", documentId: count.id, note: `Bilang ${count.docNumber}${why ? ` · ${why}` : ""}` };
      try {
        await adjustForCount(tx, leg, delta);
      } catch (e) {
        if (e instanceof InsufficientStockError) throw new StepError(conflict(`Cannot post the short for ${l.product.name}: some is held for a release that has not gone out yet. Finish the transfer/sale first, or count again.`));
        throw e;
      }
    }
    await tx.stockCountLine.update({ where: { id: l.id }, data: { postedQty: delta } });
  }
  // A consignment store pays the main store's cost for what is missing (the owner can undo it in Store payable).
  await chargeCountShort(tx, { storeId, countId: count.id, countDoc: count.docNumber, locationId: count.locationId, actorId: decidedById });
  await tx.stockCount.update({ where: { id: countId }, data: { status: "APPROVED", decidedById, decidedAt: new Date() } });
  return posted;
}

// The owner approves a full/partial count in Para sa iyo → the adjustments post. Decline → nothing changes.
registerApprovalHandler("COUNT", async (tx, a) => {
  if (a.documentType !== "COUNT") return;
  const c = await tx.stockCount.findFirst({ where: { id: a.documentId, storeId: a.storeId, status: "SUBMITTED" }, select: { id: true } });
  if (!c) return;
  if (a.status === "APPROVED") await postCount(tx, a.storeId, c.id, a.decidedById);
  else await tx.stockCount.update({ where: { id: c.id }, data: { status: "CANCELLED", decidedById: a.decidedById, decidedAt: new Date() } });
});

export class CountService {
  private async run<T>(fn: () => Promise<T>): Promise<CountResult<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof StepError) return e.result;
      if (e instanceof CountError) return invalid(e.message);
      const sig = signatureErrorResult(e);
      if (sig) return sig;
      throw e;
    }
  }

  private async location(storeId: string, actor: Actor, locationId: string | undefined) {
    const id = locationId || actor.homeLocationId;
    const loc = id ? await prisma.warehouse.findFirst({ where: { id, storeId, isActive: true }, select: { id: true, name: true } }) : null;
    if (!loc) throw new StepError(invalid("Choose a location"));
    const refusal = locationRefusal(actor, loc.id);
    if (refusal) throw new StepError(forbidden(refusal));
    return loc;
  }

  /** Lock the shelf row and read it: the moment a line is counted, its "expected" is fixed. */
  private async shelfNow(tx: Tx, storeId: string, productId: string, locationId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ quantityOnHand: number }[]>`
      SELECT "quantityOnHand" FROM "StockLevel" WHERE "storeId" = ${storeId} AND "productId" = ${productId} AND "warehouseId" = ${locationId} FOR UPDATE`;
    return rows[0]?.quantityOnHand ?? 0;
  }

  // ─────────────────────────── full / partial counts ───────────────────────────

  /** The last time each item was counted (a posted count) at a location. */
  private async lastCounted(storeId: string, locationId: string): Promise<Map<string, Date>> {
    const rows = await prisma.stockCountLine.groupBy({
      by: ["productId"],
      where: { storeId, countedQty: { not: null }, count: { locationId, status: "APPROVED" } },
      _max: { countedAt: true },
    });
    const out = new Map<string, Date>();
    for (const r of rows) if (r._max.countedAt) out.set(r.productId, r._max.countedAt);
    return out;
  }

  /** Items that can be counted at a location: every active, tracked item (even with no stock row yet), plus inactive ones that still have rice on the shelf. */
  private countable(storeId: string, locationId: string): Prisma.ProductWhereInput {
    return { storeId, trackStock: true, OR: [{ isActive: true }, { stockLevels: { some: { warehouseId: locationId, quantityOnHand: { gt: 0 } } } }] };
  }

  /**
   * The search list for the Count screen: every item that can be counted here, with when it was last counted.
   * Never carries the system's quantity (staff count blind) or any cost.
   */
  async items(storeId: string, actor: Actor, input: { locationId?: string }) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const products = await prisma.product.findMany({
        where: this.countable(storeId, loc.id),
        select: { id: true, name: true, sku: true, barcode: true, variety: true, stockBaseUnit: true, stockBaseQuantity: true },
        orderBy: { name: "asc" },
      });
      const last = await this.lastCounted(storeId, loc.id);
      return {
        location: loc,
        items: products.map((p) => ({
          productId: p.id, name: p.name, sku: p.sku, barcode: p.barcode, variety: varietyOf(p), loose: isLooseP(p),
          unitGrams: gramsIn(p, 1), lastCountedAt: last.get(p.id) ?? null,
        })),
      };
    });
  }

  /**
   * Start a list count at a location. Any role may (staff only at their own location).
   * Scope: nothing chosen = every item here; or `variety` (one kind of rice), `staleDays` (not counted for N days), `productIds` (picked items).
   * Staff always count blind; the owner/manager may ask to see the system numbers (`showSystem`).
   */
  async start(storeId: string, actor: Actor, input: { locationId?: string; productIds?: string[]; variety?: string; staleDays?: number; showSystem?: boolean; note?: string }) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const mine = await prisma.stockCount.findFirst({ where: { storeId, locationId: loc.id, status: "OPEN", kind: { in: ["FULL", "PARTIAL"] }, startedById: actor.userId }, select: { docNumber: true } });
      if (mine) throw new StepError(conflict(`You already have an open count here (${mine.docNumber}). Finish it or cancel it first.`));
      const chosen = (input.productIds ?? []).filter(Boolean);
      const variety = (input.variety ?? "").trim().toLowerCase();
      const staleDays = input.staleDays === undefined ? 0 : input.staleDays;
      if (staleDays !== 0 && (!Number.isInteger(staleDays) || staleDays < 1 || staleDays > 3650)) throw new CountError("Choose how many days (1 or more)");
      const scope = this.countable(storeId, loc.id);
      let products = await prisma.product.findMany({ where: chosen.length ? { AND: [scope, { id: { in: chosen } }] } : scope, select: { id: true, name: true, variety: true } });
      if (chosen.length && products.length !== new Set(chosen).size) throw new CountError("Unknown product");
      if (!chosen.length && variety) products = products.filter((p) => varietyOf(p) === variety);
      if (!chosen.length && staleDays) {
        const last = await this.lastCounted(storeId, loc.id);
        const cutoff = Date.now() - staleDays * 86_400_000;
        products = products.filter((p) => { const t = last.get(p.id); return !t || t.getTime() < cutoff; });
      }
      if (products.length === 0) throw new CountError("No items to count here");
      const everything = !chosen.length && !variety && !staleDays;
      const blind = !(OWNERS.includes(actor.role) && input.showSystem === true);
      return prisma.$transaction(async (tx) => {
        const docNumber = await nextDocNumber(tx, storeId, "CNT");
        const c = await tx.stockCount.create({ data: { storeId, docNumber, locationId: loc.id, kind: everything ? "FULL" : "PARTIAL", blind, note: input.note?.trim().slice(0, 200) || null, startedById: actor.userId }, select: { id: true, docNumber: true } });
        await tx.stockCountLine.createMany({ data: products.map((p) => ({ storeId, countId: c.id, productId: p.id })) });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "count.start", entityType: "StockCount", entityId: c.id, after: { locationId: loc.id, lines: products.length, blind } } });
        return { id: c.id, docNumber: c.docNumber, lines: products.length };
      }, txOptions(60_000));
    });
  }

  async list(storeId: string, actor: Actor, f: { locationId?: string; status?: string }) {
    const status = f.status && ["OPEN", "SUBMITTED", "APPROVED", "CANCELLED"].includes(f.status) ? (f.status as "OPEN") : undefined;
    const loc = f.locationId || (OWNERS.includes(actor.role) ? undefined : actor.homeLocationId ?? undefined);
    const rows = await prisma.stockCount.findMany({
      where: { storeId, ...(loc ? { locationId: loc } : {}), ...(status ? { status } : {}) },
      include: { location: { select: { name: true } }, _count: { select: { lines: true } } },
      orderBy: { startedAt: "desc" }, take: 50,
    });
    return rows.map((c) => ({ id: c.id, docNumber: c.docNumber, kind: c.kind, status: c.status, location: c.location.name, locationId: c.locationId, lines: c._count.lines, startedAt: c.startedAt, kulangValueMinor: c.kulangValueMinor, sobraValueMinor: c.sobraValueMinor, approvalId: c.approvalId, mine: c.startedById === actor.userId }));
  }

  /** One count. Staff never see the system's numbers on a blind count that is still open. */
  async get(storeId: string, actor: Actor, id: string) {
    const c = await prisma.stockCount.findFirst({ where: { id, storeId }, include: { location: { select: { name: true } }, lines: { include: { product: { select: productSelect } }, orderBy: { product: { name: "asc" } } } } });
    if (!c) return notFound();
    const refusal = locationRefusal(actor, c.locationId);
    if (refusal) return forbidden(refusal);
    // While a count is open, staff never see the system's numbers; the owner/manager see them only on a count they started with "show system numbers".
    const hide = c.status === "OPEN" && (c.blind || !OWNERS.includes(actor.role));
    const live = c.status === "OPEN" && !hide
      ? new Map((await prisma.stockLevel.findMany({ where: { storeId, warehouseId: c.locationId, productId: { in: c.lines.map((l) => l.productId) } }, select: { productId: true, quantityOnHand: true } })).map((r) => [r.productId, r.quantityOnHand] as const))
      : null;
    return {
      ok: true as const,
      value: {
        id: c.id, docNumber: c.docNumber, kind: c.kind, status: c.status, location: c.location.name, locationId: c.locationId, startedAt: c.startedAt,
        kulangValueMinor: c.kulangValueMinor, sobraValueMinor: c.sobraValueMinor, blindHidden: hide, mine: c.startedById === actor.userId,
        lines: c.lines.map((l) => ({
          productId: l.productId, name: l.product.name, loose: isLooseP(l.product), variety: varietyOf(l.product), unitGrams: gramsIn(l.product, 1), countedQty: l.countedQty, countedAt: l.countedAt,
          reason: l.reason, reasonLabel: l.reason ? REASON_LABEL[l.reason as CountReason] ?? null : null, note: l.note, firstCountedQty: l.firstCountedQty,
          ...(live ? { systemQty: live.get(l.productId) ?? 0 } : {}),
          ...(hide ? {} : {
            expectedQty: l.expectedQty, varianceQty: l.varianceQty, varianceValueMinor: l.varianceValueMinor,
            varianceGrams: l.varianceQty === null ? null : gramsIn(l.product, l.varianceQty), verdict: l.varianceQty === null ? null : verdict(l.varianceQty),
          }),
        })),
      },
    };
  }

  /** Save counted lines (re-counting a line overwrites it while the count is open). */
  async record(storeId: string, actor: Actor, id: string, lines: { productId?: string; counted?: unknown }[]) {
    return this.run(async () => {
      const c = await prisma.stockCount.findFirst({ where: { id, storeId }, include: { lines: { include: { product: { select: productSelect } } } } });
      if (!c) throw new StepError(notFound());
      const refusal = locationRefusal(actor, c.locationId);
      if (refusal) throw new StepError(forbidden(refusal));
      if (c.status !== "OPEN") throw new StepError(conflict("This count is already closed"));
      if (!Array.isArray(lines) || lines.length === 0) throw new CountError("Enter what you counted");
      const byProduct = new Map(c.lines.map((l) => [l.productId, l]));
      const parsed = lines.map((l) => {
        const line = byProduct.get(l.productId ?? "");
        if (!line) throw new CountError("That product is not in this count");
        return { line, counted: countedUnits(line.product, l.counted) };
      });
      await prisma.$transaction(async (tx) => {
        for (const { line, counted } of parsed) {
          const expected = await this.shelfNow(tx, storeId, line.productId, c.locationId);
          // Counting a line again with a different number keeps the first number, and the old reason is asked for again.
          const changed = line.countedQty !== null && line.countedQty !== counted;
          await tx.stockCountLine.update({
            where: { id: line.id },
            data: {
              expectedQty: expected, countedQty: counted, countedAt: new Date(), countedById: actor.userId,
              ...(changed ? { firstCountedQty: line.firstCountedQty ?? line.countedQty, reason: null, note: null } : {}),
            },
          });
        }
      }, txOptions(60_000));
      const done = await prisma.stockCountLine.count({ where: { countId: id, countedQty: { not: null } } });
      return { id, counted: done, total: c.lines.length };
    });
  }

  /**
   * Submit and sign: the differences post at once, for every kind of count (no owner approval).
   * A list count may leave items uncounted; they are dropped from the count and stay as they are.
   * The quick count and the closing top-5 must be counted in full.
   */
  async submit(storeId: string, actor: Actor, id: string, signatures: SignatureInput[] | undefined, recordResack?: string[]) {
    return this.run(async () => {
      const c = await prisma.stockCount.findFirst({ where: { id, storeId }, include: { location: { select: { name: true } }, lines: { include: { product: { select: productSelect } } } } });
      if (!c) throw new StepError(notFound());
      const refusal = locationRefusal(actor, c.locationId);
      if (refusal) throw new StepError(forbidden(refusal));
      const missing = c.lines.filter((l) => l.countedQty === null);
      const wholeListOnly = c.kind === "QUICK" || c.kind === "CLOSING";
      if (missing.length && wholeListOnly) throw new CountError(`Not counted yet: ${missing.slice(0, 3).map((l) => l.product.name).join(", ")}${missing.length > 3 ? ` +${missing.length - 3} more` : ""}`);
      const counted = c.lines.filter((l) => l.countedQty !== null);
      if (counted.length === 0) throw new CountError("Count at least one item first");
      const results = counted.map((l) => ({ l, r: lineResult(l.product, l.expectedQty!, l.countedQty!) }));
      // A list count needs a reason on every difference ("Don't know" is one of them).
      if (c.kind === "FULL" || c.kind === "PARTIAL") {
        const need = missingReasons(results.map(({ l, r }) => ({ name: l.product.name, varianceQty: r.varianceQty, reason: l.reason })));
        if (need.length) throw new CountError(missingReasonsMessage(need.map((x) => x.name)));
      }
      const kulang = -results.filter((x) => x.r.varianceValueMinor < 0).reduce((s, x) => s + x.r.varianceValueMinor, 0);
      const sobra = results.filter((x) => x.r.varianceValueMinor > 0).reduce((s, x) => s + x.r.varianceValueMinor, 0);
      // "A sack was opened" can be recorded as a resack at the check step, only for kinds of rice where the numbers really say so.
      const planned = new Set(planOpenedSacks(counted).map((p) => p.variety));
      const resackVarieties = (recordResack ?? []).filter((v) => typeof v === "string" && planned.has(v));
      return prisma.$transaction(async (tx) => {
        const claimed = await tx.stockCount.updateMany({ where: { id, storeId, status: "OPEN" }, data: { status: "SUBMITTED", submittedById: actor.userId, submittedAt: new Date(), kulangValueMinor: kulang, sobraValueMinor: sobra } });
        if (claimed.count === 0) throw new StepError(conflict("This count was already submitted"));
        if (missing.length) await tx.stockCountLine.deleteMany({ where: { countId: id, countedQty: null } });
        for (const { l, r } of results) await tx.stockCountLine.update({ where: { id: l.id }, data: { varianceQty: r.varianceQty, varianceValueMinor: r.varianceValueMinor } });
        await captureSignatures(tx, storeId, actor, { documentType: "COUNT", documentId: id, step: "SUBMIT", locationId: c.locationId }, signatures);
        await requireSignatures(tx, storeId, { documentType: "COUNT", documentId: id, step: "SUBMIT" });
        const posted = await postCount(tx, storeId, id, actor.userId, { resackVarieties });
        // What an opened sack explains is not a loss: the totals keep only what really had to be posted.
        let kulangNet = 0, sobraNet = 0;
        for (const { l, r } of results) {
          const v = costValue(l.product, posted.get(l.productId) ?? r.varianceQty);
          if (v < 0) kulangNet += -v; else sobraNet += v;
        }
        if (kulangNet !== kulang || sobraNet !== sobra) await tx.stockCount.update({ where: { id }, data: { kulangValueMinor: kulangNet, sobraValueMinor: sobraNet } });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "count.submit", entityType: "StockCount", entityId: id, after: { kulangValueMinor: kulangNet, sobraValueMinor: sobraNet, counted: counted.length, skipped: missing.length, posted: true, resackVarieties } } });
        return { id, docNumber: c.docNumber, status: "APPROVED" as const, approvalId: null, kulangValueMinor: kulangNet, sobraValueMinor: sobraNet, counted: counted.length, skipped: missing.length };
      }, txOptions(120_000));
    });
  }

  /**
   * The check step before submitting: only the items that differ, with the difference, a "count again"
   * hint for a big one, and the reasons to choose from. The system's number is shown here, after counting
   * (never while counting), because a difference cannot be shown without it.
   */
  async check(storeId: string, actor: Actor, id: string) {
    return this.run(async () => {
      const c = await prisma.stockCount.findFirst({ where: { id, storeId }, include: { lines: { include: { product: { select: productSelect } } } } });
      if (!c) throw new StepError(notFound());
      const refusal = locationRefusal(actor, c.locationId);
      if (refusal) throw new StepError(forbidden(refusal));
      if (c.status !== "OPEN") throw new StepError(conflict("This count is already closed"));
      const settings = await prisma.storeSettings.findUnique({ where: { storeId }, select: { countRecountMinor: true, countLookMinor: true } });
      const recountLimitMinor = settings?.countRecountMinor ?? 50_000;
      const lookLimitMinor = settings?.countLookMinor ?? 100_000;
      const counted = c.lines.filter((l) => l.countedQty !== null && l.expectedQty !== null);
      const rows = counted.map((l) => ({ l, r: lineResult(l.product, l.expectedQty!, l.countedQty!) }));
      const off = rows.filter((x) => x.r.varianceQty !== 0).sort((a, b) => Math.abs(b.r.varianceValueMinor) - Math.abs(a.r.varianceValueMinor));
      // Sacks that look opened: the sack count dropped and the loose rice of the same kind rose. A consignment store records it by itself.
      const openedAutomatic = !!(await consignmentMain(prisma, storeId, c.locationId));
      const openedSacks = planOpenedSacks(counted).map((p) => ({ variety: p.variety, sacks: p.sacks, kg: p.grams / 1000, sackName: p.sackName, looseName: p.looseName, unexplainedKg: p.unexplainedGrams / 1000 }));
      return {
        id: c.id, docNumber: c.docNumber, counted: counted.length, correct: rows.length - off.length, notCounted: c.lines.length - counted.length,
        recountLimitMinor, lookLimitMinor, openedSacks, openedAutomatic,
        lines: off.map(({ l, r }) => ({
          productId: l.productId, name: l.product.name, loose: isLooseP(l.product), countedQty: l.countedQty!, expectedQty: l.expectedQty!,
          varianceQty: r.varianceQty, varianceGrams: r.varianceGrams, varianceValueMinor: r.varianceValueMinor, verdict: r.verdict,
          firstCountedQty: l.firstCountedQty, reason: l.reason, note: l.note,
          reasons: reasonsFor(r.varianceQty).map((code) => ({ code, label: REASON_LABEL[code] })),
          asksRecount: asksRecount(r.varianceValueMinor, recountLimitMinor, l.firstCountedQty !== null),
        })),
      };
    });
  }

  private async names(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniq = Array.from(new Set(ids.filter((x): x is string => !!x)));
    if (uniq.length === 0) return new Map();
    const users = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true, phone: true, email: true } });
    return new Map(users.map((u) => [u.id, u.name || u.phone || u.email || "Staff"] as const));
  }

  /**
   * One posted count explained: what differs (with the reason), what happened to each item since the
   * last count, the weight of each kind of rice, the resack jobs around it, and (owner) what Store 2 was charged.
   */
  async report(storeId: string, actor: Actor, id: string) {
    return this.run(async () => {
      const c = await prisma.stockCount.findFirst({ where: { id, storeId }, include: { location: { select: { id: true, name: true } }, lines: { include: { product: { select: productSelect } } } } });
      if (!c) throw new StepError(notFound());
      const refusal = locationRefusal(actor, c.locationId);
      if (refusal) throw new StepError(forbidden(refusal));
      if (c.status === "OPEN") throw new StepError(conflict("Finish the count first"));
      if (c.status === "CANCELLED") throw new StepError(conflict("This count was cancelled"));
      const owner = OWNERS.includes(actor.role);
      const counted = c.lines.filter((l) => l.countedQty !== null && l.expectedQty !== null);
      // A sack opened and recorded as a resack explains part of a difference: only what was left over is a real loss or gain.
      const rows = counted.map((l) => {
        const r = lineResult(l.product, l.expectedQty!, l.countedQty!);
        const leftoverQty = l.postedQty ?? r.varianceQty;
        return { l, r, leftoverQty, leftoverValueMinor: costValue(l.product, leftoverQty) };
      });
      const differing = rows.filter((x) => x.r.varianceQty !== 0).sort((a, b) => Math.abs(b.leftoverValueMinor) - Math.abs(a.leftoverValueMinor) || Math.abs(b.r.varianceValueMinor) - Math.abs(a.r.varianceValueMinor));
      const correct = rows.filter((x) => x.r.varianceQty === 0);
      const names = await this.names([c.startedById, c.submittedById, ...counted.map((x) => x.countedById)]);

      // What happened to each differing item since the count before (the 20 biggest differences).
      const lines: ReportLine[] = [];
      for (const [i, { l, r, leftoverQty, leftoverValueMinor }] of differing.entries()) {
        let since: { from: { docNumber: string; countedQty: number; countedAt: Date } | null; buckets: Record<string, number>; ledgerShouldBe: number } | null = null;
        if (i < 20 && l.countedAt) {
          const prev = await prisma.stockCountLine.findFirst({
            where: { storeId, productId: l.productId, countedQty: { not: null }, postedQty: { not: null }, countId: { not: c.id }, countedAt: { lt: l.countedAt }, count: { locationId: c.locationId, status: "APPROVED" } },
            orderBy: { countedAt: "desc" }, select: { countId: true, countedQty: true, countedAt: true, count: { select: { docNumber: true } } },
          });
          const moves = await prisma.stockMovement.findMany({
            where: {
              storeId, productId: l.productId, warehouseId: c.locationId,
              createdAt: { ...(prev ? { gt: prev.countedAt! } : {}), lte: l.countedAt },
              ...(prev ? { NOT: { documentType: "COUNT", documentId: prev.countId } } : {}),
            },
            select: { type: true, delta: true },
          });
          const { expected, buckets } = balanceOf(prev?.countedQty ?? 0, moves);
          since = { from: prev ? { docNumber: prev.count.docNumber, countedQty: prev.countedQty!, countedAt: prev.countedAt! } : null, buckets, ledgerShouldBe: expected };
        }
        lines.push({
          productId: l.productId, name: l.product.name, loose: isLooseP(l.product), countedQty: l.countedQty!, expectedQty: l.expectedQty!, firstCountedQty: l.firstCountedQty,
          varianceQty: r.varianceQty, varianceValueMinor: leftoverValueMinor, explainedQty: r.varianceQty - leftoverQty, verdict: r.verdict,
          reason: l.reason, reasonLabel: l.reason ? REASON_LABEL[l.reason as CountReason] ?? null : null, note: l.note, countedBy: names.get(l.countedById ?? "") ?? null, since,
        });
      }

      // The weight of each kind of rice (sacks and loose together), so an opened sack never looks like a loss.
      const stocked = await prisma.stockLevel.findMany({ where: { storeId, warehouseId: c.locationId, quantityOnHand: { gt: 0 } }, include: { product: { select: productSelect } } });
      const countedIds = new Set(rows.map((x) => x.l.productId));
      const notCountedKinds = new Set(stocked.filter((x) => !countedIds.has(x.productId) && gramsIn(x.product, 1) !== null).map((x) => varietyOf(x.product)));
      const kinds = new Map<string, { variety: string; countedG: number; systemG: number; parts: { name: string; countedKg: number; systemKg: number }[] }>();
      for (const { l } of rows) {
        const g = gramsIn(l.product, 1);
        if (g === null) continue;
        const v = varietyOf(l.product);
        const k = kinds.get(v) ?? { variety: v, countedG: 0, systemG: 0, parts: [] };
        k.countedG += l.countedQty! * g;
        k.systemG += l.expectedQty! * g;
        k.parts.push({ name: l.product.name, countedKg: (l.countedQty! * g) / 1000, systemKg: (l.expectedQty! * g) / 1000 });
        kinds.set(v, k);
      }
      const weight = Array.from(kinds.values()).map((k) => ({ variety: k.variety, countedKg: k.countedG / 1000, systemKg: k.systemG / 1000, diffKg: (k.countedG - k.systemG) / 1000, complete: !notCountedKinds.has(k.variety), parts: k.parts }))
        .sort((a, b) => Math.abs(b.diffKg) - Math.abs(a.diffKg) || a.variety.localeCompare(b.variety));

      // Resack jobs of the kinds of rice that differ, in the 30 days before the count.
      const diffKinds = new Set(differing.map((x) => varietyOf(x.l.product)));
      const jobs = diffKinds.size === 0 ? [] : await prisma.resackJob.findMany({
        where: { storeId, locationId: c.locationId, status: { not: "CANCELLED" }, startedAt: { gte: new Date(c.startedAt.getTime() - 30 * 86_400_000), lte: c.decidedAt ?? c.startedAt } },
        include: { inputProduct: { select: productSelect }, outputs: { include: { product: { select: productSelect } } } }, orderBy: { startedAt: "desc" }, take: 40,
      });
      const resacks = jobs.filter((j) => diffKinds.has(varietyOf(j.inputProduct))).slice(0, 10).map((j) => ({
        docNumber: j.docNumber, at: j.startedAt, status: j.status,
        from: `${qtyText(j.inputProduct, j.inputQty)}${isLooseP(j.inputProduct) ? "" : " ×"} ${j.inputProduct.name}`,
        to: j.outputs.map((o) => `${qtyText(o.product, o.quantity)}${isLooseP(o.product) ? "" : " ×"} ${o.product.name}`).join(", "),
        lossGrams: j.lossGrams,
      }));

      // What the consignment store was charged for what is missing (owner only: it is at cost).
      let charge: { totalMinor: number; entries: { docNumber: string; product: string; quantity: number; amountMinor: number; undone: boolean }[] } | null = null;
      if (owner) {
        const entries = await prisma.storePayableEntry.findMany({ where: { storeId, kind: "CHARGE", sourceLineId: { in: c.lines.map((l) => l.id) } }, select: { id: true, docNumber: true, amountMinor: true, productId: true, quantity: true } });
        if (entries.length) {
          const undone = new Set((await prisma.storePayableEntry.findMany({ where: { storeId, reversesId: { in: entries.map((e) => e.id) } }, select: { reversesId: true } })).map((e) => e.reversesId));
          const nameOf = new Map(c.lines.map((l) => [l.productId, l.product.name] as const));
          const list = entries.map((e) => ({ docNumber: e.docNumber, product: nameOf.get(e.productId ?? "") ?? "", quantity: e.quantity ?? 0, amountMinor: e.amountMinor, undone: undone.has(e.id) }));
          charge = { totalMinor: list.filter((e) => !e.undone).reduce((sum, e) => sum + e.amountMinor, 0), entries: list };
        }
      }

      const opened = await prisma.auditLog.findMany({ where: { storeId, action: "count.auto_resack", entityId: c.id }, select: { after: true }, orderBy: { createdAt: "asc" } });
      const openedByCount = opened.map((o) => {
        const a = (o.after ?? {}) as { variety?: string; sacksOpened?: number; grams?: number; unexplainedGrams?: number; automatic?: boolean };
        return { variety: a.variety ?? "", sacks: a.sacksOpened ?? 0, kg: (a.grams ?? 0) / 1000, unexplainedKg: (a.unexplainedGrams ?? 0) / 1000, automatic: a.automatic === true };
      });
      return {
        count: { id: c.id, docNumber: c.docNumber, kind: c.kind, status: c.status, location: c.location.name, locationId: c.locationId, startedAt: c.startedAt, postedAt: c.decidedAt ?? c.submittedAt, countedBy: Array.from(new Set(counted.map((x) => names.get(x.countedById ?? "")).filter(Boolean))).join(", ") || names.get(c.startedById) || null },
        summary: {
          counted: counted.length, correct: correct.length, short: differing.filter((x) => x.leftoverQty < 0).length, over: differing.filter((x) => x.leftoverQty > 0).length,
          explained: differing.filter((x) => x.leftoverQty === 0).length, kulangValueMinor: c.kulangValueMinor, sobraValueMinor: c.sobraValueMinor,
        },
        openedByCount,
        lines, correct: correct.map((x) => ({ productId: x.l.productId, name: x.l.product.name, loose: isLooseP(x.l.product), countedQty: x.l.countedQty! })).sort((a, b) => a.name.localeCompare(b.name)),
        weight, resacks, charge,
      };
    });
  }

  /** Counts posted in a period (staff: their own store), with the totals, the shortages by reason, and every difference for the Excel file. */
  async reportList(storeId: string, actor: Actor, f: { locationId?: string; from?: string; to?: string }) {
    return this.run(async () => {
      const day = /^\d{4}-\d{2}-\d{2}$/;
      const todayMnl = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
      const to = f.to && day.test(f.to) ? f.to : todayMnl;
      const from = f.from && day.test(f.from) ? f.from : new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
      if (from > to) throw new CountError("The first date is after the last date");
      const isOwner = OWNERS.includes(actor.role);
      if (!isOwner && !actor.homeLocationId) throw new StepError(forbidden("You are not assigned to a location"));
      const loc = isOwner ? f.locationId || undefined : actor.homeLocationId ?? undefined;
      const counts = await prisma.stockCount.findMany({
        where: { storeId, status: "APPROVED", decidedAt: { gte: new Date(`${from}T00:00:00+08:00`), lte: new Date(`${to}T23:59:59.999+08:00`) }, ...(loc ? { locationId: loc } : {}) },
        include: {
          location: { select: { name: true } },
          lines: { select: { productId: true, expectedQty: true, countedQty: true, varianceQty: true, postedQty: true, reason: true, note: true, countedById: true, product: { select: { name: true, stockBaseUnit: true, stockBaseQuantity: true, costMinor: true } } } },
        },
        orderBy: { decidedAt: "desc" }, take: 200,
      });
      const names = await this.names(counts.flatMap((c) => [c.startedById, ...c.lines.map((l) => l.countedById)]));
      const reasons = new Map<string, { code: string; label: string; items: number; shortValueMinor: number; overValueMinor: number }>();
      const differences: ReportDifference[] = [];
      let correct = 0, short = 0, over = 0, kulang = 0, sobra = 0, items = 0;
      const summaries = counts.map((c) => {
        const done = c.lines.filter((l) => l.countedQty !== null);
        let cShort = 0, cOver = 0, cCorrect = 0;
        for (const l of done) {
          const v = l.varianceQty ?? 0;
          if (v === 0) { cCorrect++; continue; }
          const left = l.postedQty ?? v; // what an opened sack explains is not a loss
          const value = costValue(l.product, left);
          if (left < 0) cShort++; else if (left > 0) cOver++;
          const code = l.reason ?? "NONE";
          const r = reasons.get(code) ?? { code, label: l.reason ? REASON_LABEL[l.reason as CountReason] ?? l.reason : "No reason (older count)", items: 0, shortValueMinor: 0, overValueMinor: 0 };
          r.items++;
          if (value < 0) r.shortValueMinor += -value; else r.overValueMinor += value;
          reasons.set(code, r);
          if (differences.length < 2000) {
            differences.push({
              docNumber: c.docNumber, postedAt: c.decidedAt, location: c.location.name, item: l.product.name, loose: isLooseP(l.product), countedQty: l.countedQty, expectedQty: l.expectedQty, varianceQty: v,
              varianceValueMinor: value, reason: l.reason, reasonLabel: l.reason ? REASON_LABEL[l.reason as CountReason] ?? null : null, note: l.note, countedBy: names.get(l.countedById ?? "") ?? null,
            });
          }
        }
        correct += cCorrect; short += cShort; over += cOver; kulang += c.kulangValueMinor; sobra += c.sobraValueMinor; items += done.length;
        return { id: c.id, docNumber: c.docNumber, kind: c.kind, location: c.location.name, locationId: c.locationId, postedAt: c.decidedAt, items: done.length, correct: cCorrect, short: cShort, over: cOver, kulangValueMinor: c.kulangValueMinor, sobraValueMinor: c.sobraValueMinor, countedBy: Array.from(new Set(done.map((l) => names.get(l.countedById ?? "")).filter(Boolean))).join(", ") || names.get(c.startedById) || null };
      });
      return {
        from, to, locationId: loc ?? null,
        totals: { counts: counts.length, items, correct, short, over, kulangValueMinor: kulang, sobraValueMinor: sobra },
        byReason: Array.from(reasons.values()).sort((a, b) => b.shortValueMinor + b.overValueMinor - (a.shortValueMinor + a.overValueMinor)),
        counts: summaries, differences,
      };
    });
  }

  /** Owner/manager: every item against every store, with when it was last counted and what the system holds. */
  async overview(storeId: string, actor: Actor) {
    return this.run(async () => {
      if (!OWNERS.includes(actor.role)) throw new StepError(forbidden("Only the owner or a manager can see all stores"));
      const [locations, products, levels, last] = await Promise.all([
        prisma.warehouse.findMany({ where: { storeId, isActive: true }, select: { id: true, name: true, type: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
        prisma.product.findMany({ where: { storeId, trackStock: true }, select: { id: true, name: true, variety: true, isActive: true, stockBaseUnit: true, stockBaseQuantity: true }, orderBy: { name: "asc" } }),
        prisma.stockLevel.findMany({ where: { storeId }, select: { productId: true, warehouseId: true, quantityOnHand: true } }),
        prisma.$queryRaw<{ productId: string; locationId: string; last: Date }[]>`
          SELECT l."productId", c."locationId", MAX(l."countedAt") AS "last"
            FROM "StockCountLine" l JOIN "StockCount" c ON c."id" = l."countId"
           WHERE l."storeId" = ${storeId} AND l."countedQty" IS NOT NULL AND c."status" = 'APPROVED'
           GROUP BY l."productId", c."locationId"`,
      ]);
      const onHand = new Map<string, number>(levels.map((l) => [`${l.productId}|${l.warehouseId}`, l.quantityOnHand]));
      const lastAt = new Map<string, Date>(last.map((l) => [`${l.productId}|${l.locationId}`, l.last]));
      const items: { productId: string; name: string; variety: string; loose: boolean; cells: Record<string, { lastCountedAt: Date | null; onHand: number }> }[] = [];
      for (const p of products) {
        const cells: Record<string, { lastCountedAt: Date | null; onHand: number }> = {};
        for (const loc of locations) {
          const key = `${p.id}|${loc.id}`;
          const qty = onHand.get(key) ?? 0;
          const at = lastAt.get(key) ?? null;
          if (qty > 0 || at) cells[loc.id] = { lastCountedAt: at, onHand: qty };
        }
        if (!p.isActive && Object.keys(cells).length === 0) continue;
        items.push({ productId: p.id, name: p.name, variety: varietyOf(p), loose: isLooseP(p), cells });
      }
      return { locations, items };
    });
  }

  // ─────────────────────────── the owner's side: needs a look, limits, suggestions, accuracy ───────────────────────────

  private ownerOnly(actor: Actor) {
    if (!OWNERS.includes(actor.role)) throw new StepError(forbidden("Only the owner or a manager can see this"));
  }

  private async limitsOf(storeId: string) {
    const s = await prisma.storeSettings.findUnique({ where: { storeId }, select: { countRecountMinor: true, countLookMinor: true } });
    return { recountMinor: s?.countRecountMinor ?? 50_000, lookMinor: s?.countLookMinor ?? 100_000 };
  }

  /** Counts that nobody has looked at yet and that need it: a big difference, an over count, the same item short again and again, many "Don't know". */
  async looks(storeId: string, actor: Actor) {
    return this.run(async () => {
      this.ownerOnly(actor);
      const limits = await this.limitsOf(storeId);
      const now = Date.now();
      const counts = await prisma.stockCount.findMany({
        where: { storeId, status: "APPROVED", decidedAt: { gte: new Date(now - REPEAT_DAYS * 86_400_000) } },
        include: {
          location: { select: { name: true } },
          lines: { where: { countedQty: { not: null } }, select: { id: true, productId: true, reason: true, varianceQty: true, postedQty: true, product: { select: productSelect } } },
        },
        orderBy: { decidedAt: "desc" }, take: 300,
      });
      const rows: LookCount[] = counts.map((c) => ({
        id: c.id, locationId: c.locationId, decidedAt: c.decidedAt ?? c.startedAt, lookStatus: c.lookStatus,
        lines: c.lines.map((l) => {
          const left = l.postedQty ?? l.varianceQty ?? 0;
          return { productId: l.productId, name: l.product.name, leftoverQty: left, valueMinor: costValue(l.product, left), reason: l.reason };
        }),
      }));
      const flagged = needsLook(rows, limits, now);
      const byId = new Map(counts.map((c) => [c.id, c] as const));
      const lineCount = new Map<string, string>();
      for (const f of flagged) for (const l of byId.get(f.id)?.lines ?? []) lineCount.set(l.id, f.id);
      // What the consignment store was charged for each of these counts (not counting what was undone).
      const charged = new Map<string, number>();
      if (lineCount.size) {
        const entries = await prisma.storePayableEntry.findMany({ where: { storeId, kind: "CHARGE", sourceLineId: { in: Array.from(lineCount.keys()) } }, select: { id: true, amountMinor: true, sourceLineId: true } });
        const undone = new Set((await prisma.storePayableEntry.findMany({ where: { storeId, reversesId: { in: entries.map((e) => e.id) } }, select: { reversesId: true } })).map((e) => e.reversesId));
        for (const e of entries) {
          const cid = lineCount.get(e.sourceLineId ?? "");
          if (cid && !undone.has(e.id)) charged.set(cid, (charged.get(cid) ?? 0) + e.amountMinor);
        }
      }
      const names = await this.names(flagged.map((f) => byId.get(f.id)?.submittedById ?? byId.get(f.id)?.startedById));
      return {
        limits,
        items: flagged.map((f) => {
          const c = byId.get(f.id)!;
          return {
            count: { id: c.id, docNumber: c.docNumber, kind: c.kind, location: c.location.name, locationId: c.locationId, decidedAt: c.decidedAt, countedBy: names.get(c.submittedById ?? c.startedById) ?? null },
            flags: f.flags.map((x) => ({ kind: x.kind, text: flagText(x), productId: x.productId, valueMinor: x.valueMinor, times: x.times })),
            chargeMinor: charged.get(f.id) ?? 0,
          };
        }),
      };
    });
  }

  /** The owner looked at a count: it leaves the list (a note is optional). */
  async review(storeId: string, actor: Actor, id: string, note: unknown) {
    return this.run(async () => {
      this.ownerOnly(actor);
      const c = await prisma.stockCount.findFirst({ where: { id, storeId, status: "APPROVED" }, select: { id: true, docNumber: true } });
      if (!c) throw new StepError(notFound());
      const text = cleanNote(note);
      await prisma.$transaction(async (tx) => {
        await tx.stockCount.update({ where: { id }, data: { lookStatus: "OK", lookNote: text, reviewedById: actor.userId, reviewedAt: new Date() } });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "count.review", entityType: "StockCount", entityId: id, after: { lookStatus: "OK", note: text } } });
      });
      return { id, docNumber: c.docNumber, lookStatus: "OK" as const };
    });
  }

  async getLimits(storeId: string, actor: Actor) {
    return this.run(async () => {
      this.ownerOnly(actor);
      return this.limitsOf(storeId);
    });
  }

  /** The two limits, in centavos: ask to count again from this much; put on the owner's list from this much. 0 switches one off. */
  async setLimits(storeId: string, actor: Actor, input: { recountMinor: unknown; lookMinor: unknown }) {
    return this.run(async () => {
      this.ownerOnly(actor);
      const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000_000;
      if (!ok(input.recountMinor) || !ok(input.lookMinor)) throw new CountError("Enter the amounts in pesos (0 switches one off)");
      await prisma.storeSettings.upsert({
        where: { storeId }, update: { countRecountMinor: input.recountMinor, countLookMinor: input.lookMinor },
        create: { storeId, countRecountMinor: input.recountMinor, countLookMinor: input.lookMinor },
      });
      await prisma.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "count.limits", entityType: "StoreSettings", entityId: storeId, after: { recountMinor: input.recountMinor, lookMinor: input.lookMinor } } });
      return { recountMinor: input.recountMinor, lookMinor: input.lookMinor };
    });
  }

  /** About ten items to count today: never counted first, then fast sellers weekly and the rest monthly. Any role, at their own store. */
  async suggest(storeId: string, actor: Actor, input: { locationId?: string }) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const now = Date.now();
      const [products, last, sales, levels] = await Promise.all([
        prisma.product.findMany({ where: this.countable(storeId, loc.id), select: { id: true, name: true } }),
        this.lastCounted(storeId, loc.id),
        prisma.stockMovement.groupBy({ by: ["productId"], where: { storeId, warehouseId: loc.id, type: "CONSUME", createdAt: { gte: new Date(now - 30 * 86_400_000) } }, _count: { _all: true } }),
        prisma.stockLevel.findMany({ where: { storeId, warehouseId: loc.id }, select: { productId: true, quantityOnHand: true } }),
      ]);
      const sold = new Map(sales.map((x) => [x.productId, x._count._all] as const));
      const held = new Map(levels.map((x) => [x.productId, x.quantityOnHand] as const));
      const list = suggestList(products.map((p) => ({ productId: p.id, name: p.name, lastCountedAt: last.get(p.id) ?? null, sales30: sold.get(p.id) ?? 0, onHand: held.get(p.id) ?? 0 })), now, 10);
      return { location: loc, items: list.map((x) => ({ productId: x.productId, name: x.name, why: x.why, days: x.days, text: suggestText(x) })) };
    });
  }

  /** The share of items right on the first count, over the last 4 weeks: all together, per store and per person. */
  async accuracy(storeId: string, actor: Actor) {
    return this.run(async () => {
      this.ownerOnly(actor);
      const now = Date.now();
      const rows = await prisma.stockCountLine.findMany({
        where: { storeId, countedQty: { not: null }, expectedQty: { not: null }, countedAt: { gte: new Date(now - 28 * 86_400_000) }, count: { status: "APPROVED" } },
        select: { countedAt: true, countedById: true, countedQty: true, firstCountedQty: true, expectedQty: true, count: { select: { locationId: true } } },
        take: 50_000,
      });
      const all: (AccLine & { by: string | null; at: string })[] = rows.map((r) => ({ countedAt: r.countedAt ?? new Date(now), countedQty: r.countedQty ?? 0, firstCountedQty: r.firstCountedQty, expectedQty: r.expectedQty ?? 0, by: r.countedById, at: r.count.locationId }));
      const [locs, names] = await Promise.all([
        prisma.warehouse.findMany({ where: { storeId, isActive: true }, select: { id: true, name: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }),
        this.names(all.map((x) => x.by)),
      ]);
      const people = new Map<string, AccLine[]>();
      for (const x of all) if (x.by) people.set(x.by, [...(people.get(x.by) ?? []), x]);
      return {
        days: 28,
        total: { ...accStat(all), weeks: weeklyTrend(all, now) },
        locations: locs.map((l) => { const mine = all.filter((x) => x.at === l.id); return { locationId: l.id, name: l.name, ...accStat(mine), weeks: weeklyTrend(mine, now) }; }).filter((l) => l.counted > 0),
        people: Array.from(people, ([userId, lines]) => ({ userId, name: names.get(userId) ?? "Staff", ...accStat(lines) })).sort((a, b) => b.counted - a.counted),
      };
    });
  }

  /**
   * Set the reason (and an optional note) on counted lines that differ. Allowed while the count is open
   * (the check step), and for 48 hours after it posted by the person who counted the line or the owner
   * (the one-item count asks "why?" after it posts).
   */
  async setReasons(storeId: string, actor: Actor, id: string, input: { productId?: string; reason?: unknown; note?: unknown }[]) {
    return this.run(async () => {
      const c = await prisma.stockCount.findFirst({ where: { id, storeId }, include: { lines: true } });
      if (!c) throw new StepError(notFound());
      const refusal = locationRefusal(actor, c.locationId);
      if (refusal) throw new StepError(forbidden(refusal));
      const open = c.status === "OPEN";
      const postedAt = c.decidedAt ?? c.submittedAt ?? c.startedAt;
      if (!open && !(c.status === "APPROVED" && Date.now() - postedAt.getTime() < 48 * 3_600_000)) throw new StepError(conflict("This count is closed — the reasons can no longer be changed"));
      if (!Array.isArray(input) || input.length === 0) throw new CountError("Choose a reason");
      const byProduct = new Map(c.lines.map((l) => [l.productId, l]));
      const prepared = input.map((x) => {
        const line = byProduct.get(x.productId ?? "");
        if (!line) throw new CountError("That product is not in this count");
        if (line.countedQty === null || line.expectedQty === null) throw new CountError("Count it first");
        if (!open && !OWNERS.includes(actor.role) && line.countedById !== actor.userId) throw new StepError(forbidden("Only the person who counted it, or the owner, can change this"));
        return { line, reason: checkReason(line.countedQty - line.expectedQty, x.reason), note: cleanNote(x.note) };
      });
      await prisma.$transaction(async (tx) => {
        for (const p of prepared) await tx.stockCountLine.update({ where: { id: p.line.id }, data: { reason: p.reason, note: p.note } });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "count.reasons", entityType: "StockCount", entityId: id, after: { lines: prepared.length } } });
      }, txOptions(60_000));
      return { id, saved: prepared.length };
    });
  }

  /** The owner/manager, or the person who started the count, may cancel it while it is open. */
  async cancel(storeId: string, actor: Actor, id: string) {
    const c = await prisma.stockCount.findFirst({ where: { id, storeId }, select: { locationId: true, startedById: true } });
    if (!c) return notFound();
    const refusal = locationRefusal(actor, c.locationId);
    if (refusal) return forbidden(refusal);
    if (!OWNERS.includes(actor.role) && c.startedById !== actor.userId) return forbidden("Only the person who started this count, or the owner, can cancel it");
    const r = await prisma.stockCount.updateMany({ where: { id, storeId, status: "OPEN" }, data: { status: "CANCELLED", decidedById: actor.userId, decidedAt: new Date() } });
    return r.count ? { ok: true as const, value: { id, status: "CANCELLED" } } : conflict("This count is no longer open");
  }

  // ─────────────────────────── quick counts ───────────────────────────

  /** "May natira pa ba?" — the zero check: count one item now; the difference posts at once. */
  async quick(storeId: string, actor: Actor, input: { locationId?: string; productId?: string; counted?: unknown; signatures?: SignatureInput[] }) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const p = input.productId ? await prisma.product.findFirst({ where: { id: input.productId, storeId, isActive: true }, select: productSelect }) : null;
      if (!p) throw new CountError("Choose a product");
      const counted = countedUnits(p, input.counted);
      const out = await prisma.$transaction(async (tx) => {
        const docNumber = await nextDocNumber(tx, storeId, "CNT");
        const expected = await this.shelfNow(tx, storeId, p.id, loc.id);
        const r = lineResult(p, expected, counted);
        const c = await tx.stockCount.create({
          data: {
            storeId, docNumber, locationId: loc.id, kind: "QUICK", status: "SUBMITTED", startedById: actor.userId, submittedById: actor.userId, submittedAt: new Date(),
            kulangValueMinor: Math.max(0, -r.varianceValueMinor), sobraValueMinor: Math.max(0, r.varianceValueMinor),
            lines: { create: { storeId, productId: p.id, expectedQty: expected, countedQty: counted, countedAt: new Date(), countedById: actor.userId, varianceQty: r.varianceQty, varianceValueMinor: r.varianceValueMinor } },
          },
          select: { id: true },
        });
        await captureSignatures(tx, storeId, actor, { documentType: "COUNT", documentId: c.id, step: "QUICK", locationId: loc.id }, input.signatures);
        await requireSignatures(tx, storeId, { documentType: "COUNT", documentId: c.id, step: "QUICK" });
        await postCount(tx, storeId, c.id, actor.userId);
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "count.quick", entityType: "StockCount", entityId: c.id, after: { productId: p.id, expected, counted } } });
        return { id: c.id, docNumber, productId: p.id, expectedQty: expected, countedQty: counted, ...r, reasons: reasonsFor(r.varianceQty).map((code) => ({ code, label: REASON_LABEL[code] })) };
      }, txOptions());
      await cacheBust(cacheKey("products", storeId));
      return out;
    });
  }

  /** Closing: a quick count of the 5 items this location sold most today (posted on submit). */
  async startClosing(storeId: string, actor: Actor, input: { locationId?: string }) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const since = new Date(Date.now() - 18 * 3_600_000);
      const top = await prisma.orderItem.groupBy({
        by: ["productId"], where: { storeId, productId: { not: null }, order: { sellingLocationId: loc.id, createdAt: { gte: since }, status: { not: "CANCELLED" } } },
        _count: { _all: true }, orderBy: { _count: { productId: "desc" } }, take: 5,
      });
      let ids = top.map((t) => t.productId!).filter(Boolean);
      if (ids.length < 5) {
        const more = await prisma.stockLevel.findMany({ where: { storeId, warehouseId: loc.id, productId: { notIn: ids }, product: { isActive: true } }, orderBy: { quantityOnHand: "desc" }, take: 5 - ids.length, select: { productId: true } });
        ids = [...ids, ...more.map((m) => m.productId)];
      }
      if (ids.length === 0) throw new CountError("No products to count here");
      return prisma.$transaction(async (tx) => {
        const docNumber = await nextDocNumber(tx, storeId, "CNT");
        const c = await tx.stockCount.create({ data: { storeId, docNumber, locationId: loc.id, kind: "CLOSING", startedById: actor.userId, note: "Closing count (top 5)" }, select: { id: true, docNumber: true } });
        await tx.stockCountLine.createMany({ data: ids.map((productId) => ({ storeId, countId: c.id, productId })) });
        return { id: c.id, docNumber: c.docNumber, lines: ids.length };
      });
    });
  }

  // ─────────────────────────── the balance ───────────────────────────

  /**
   * Balance per item at a location: expected = last posted count + every shelf movement since.
   * `matches` is false only when the ledger and the shelf number disagree (that is a bug,
   * never a "kulang": a kulang is found by counting).
   */
  async balance(storeId: string, actor: Actor, input: { locationId?: string; productId?: string }) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const levels = await prisma.stockLevel.findMany({
        where: { storeId, warehouseId: loc.id, ...(input.productId ? { productId: input.productId } : {}) },
        include: { product: { select: productSelect } },
      });
      const out = [];
      for (const lv of levels) {
        const last = await prisma.stockCountLine.findFirst({
          where: { storeId, productId: lv.productId, countedQty: { not: null }, postedQty: { not: null }, count: { locationId: loc.id, status: "APPROVED" } },
          orderBy: { countedAt: "desc" }, select: { countId: true, countedQty: true, countedAt: true, count: { select: { docNumber: true } } },
        });
        const moves = await prisma.stockMovement.findMany({
          where: {
            storeId, productId: lv.productId, warehouseId: loc.id,
            ...(last ? { createdAt: { gt: last.countedAt! }, NOT: { documentType: "COUNT", documentId: last.countId } } : {}),
          },
          select: { type: true, delta: true },
        });
        const { expected, buckets } = balanceOf(last?.countedQty ?? 0, moves);
        out.push({
          productId: lv.productId, name: lv.product.name, loose: isLooseP(lv.product),
          lastCount: last ? { docNumber: last.count.docNumber, countedQty: last.countedQty, countedAt: last.countedAt } : null,
          buckets, expected, onHand: lv.quantityOnHand, reserved: lv.quantityReserved, matches: expected === lv.quantityOnHand,
          valueMinor: costValue(lv.product, lv.quantityOnHand),
        });
      }
      return { location: loc, items: out.sort((a, b) => a.name.localeCompare(b.name)) };
    });
  }

  // ─────────────────────────── Manual na bawas ───────────────────────────

  async writeOff(
    storeId: string, actor: Actor,
    input: { locationId?: string; productId?: string; quantity?: unknown; kilos?: unknown; reason?: unknown; note?: string; signatures?: SignatureInput[] },
  ) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const p = input.productId ? await prisma.product.findFirst({ where: { id: input.productId, storeId, isActive: true }, select: productSelect }) : null;
      if (!p) throw new CountError("Choose a product");
      const qty = isLooseP(p) && input.kilos !== undefined ? countedUnits(p, input.kilos) : input.quantity;
      const out = await prisma.$transaction(async (tx) => {
        const before = await this.shelfNow(tx, storeId, p.id, loc.id);
        const chk = writeOffCheck(before, qty, input.reason, input.note);
        const docNumber = await nextDocNumber(tx, storeId, "WO");
        const value = costValue(p, chk.qty);
        const wo = await tx.stockWriteOff.create({
          data: { storeId, docNumber, locationId: loc.id, productId: p.id, quantity: chk.qty, reason: chk.reason, note: input.note?.trim().slice(0, 200) || null, valueMinor: value, lossBp: chk.lossBp, createdById: actor.userId },
          select: { id: true },
        });
        await captureSignatures(tx, storeId, actor, { documentType: "WRITE_OFF", documentId: wo.id, step: "CREATE", locationId: loc.id }, input.signatures);
        await requireSignatures(tx, storeId, { documentType: "WRITE_OFF", documentId: wo.id, step: "CREATE" });
        try {
          await releaseForTrip(tx, { storeId, productId: p.id, warehouseId: loc.id, actorId: actor.userId, documentType: "WRITE_OFF", documentId: wo.id, note: `${docNumber} ${WRITE_OFF_LABEL[chk.reason]}` }, 0, chk.qty, "WRITE_OFF");
        } catch (e) {
          if (e instanceof InsufficientStockError) throw new StepError(conflict(`Some ${p.name} here is held for a release — only ${qtyText(p, Math.max(0, chk.qty - e.shortfall))} can be written off`));
          throw e;
        }
        let approvalId: string | null = null;
        if (chk.needsApproval) {
          approvalId = (await requestApproval(tx, {
            storeId, kind: "WRITE_OFF", documentType: "WRITE_OFF", documentId: wo.id, locationId: loc.id,
            summary: `Write-off ${docNumber} at ${loc.name}: ${qtyText(p, chk.qty)}${isLooseP(p) ? "" : " ×"} ${p.name} — ${WRITE_OFF_LABEL[chk.reason]}${input.note?.trim() ? ` (${input.note.trim().slice(0, 80)})` : ""}. ₱${(value / 100).toFixed(2)}, ${(chk.lossBp / 100).toFixed(2)}% of stock on hand.`,
            detail: { quantity: chk.qty, valueMinor: value, lossBp: chk.lossBp, reason: chk.reason },
            requestedById: actor.userId,
          })).id;
          await tx.stockWriteOff.update({ where: { id: wo.id }, data: { approvalId } });
        }
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "stock.write_off", entityType: "StockWriteOff", entityId: wo.id, after: { quantity: chk.qty, reason: chk.reason, valueMinor: value } } });
        return { id: wo.id, docNumber, quantity: chk.qty, valueMinor: value, lossBp: chk.lossBp, needsApproval: chk.needsApproval, approvalId };
      }, txOptions());
      await cacheBust(cacheKey("products", storeId));
      return out;
    });
  }

  async writeOffs(storeId: string, actor: Actor, f: { locationId?: string }) {
    const loc = f.locationId || (OWNERS.includes(actor.role) ? undefined : actor.homeLocationId ?? undefined);
    const rows = await prisma.stockWriteOff.findMany({
      where: { storeId, ...(loc ? { locationId: loc } : {}) }, orderBy: { createdAt: "desc" }, take: 100,
      include: { product: { select: { name: true, stockBaseUnit: true, stockBaseQuantity: true } }, location: { select: { name: true } } },
    });
    return rows.map((w) => ({ id: w.id, docNumber: w.docNumber, product: w.product.name, loose: isLooseP(w.product), quantity: w.quantity, reason: w.reason, reasonLabel: WRITE_OFF_LABEL[w.reason], note: w.note, valueMinor: w.valueMinor, lossBp: w.lossBp, approvalId: w.approvalId, location: w.location.name, createdAt: w.createdAt }));
  }
}
