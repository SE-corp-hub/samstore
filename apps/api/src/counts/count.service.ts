// Rice Ops M8 — Bilangin (counts), the balance, and Manual na bawas (write-offs).
//
//   Full / partial count: the owner starts it for one location; staff count WITHOUT seeing
//   the system's numbers (blind); each line keeps what the system had at the moment it was
//   counted, so sales during the count never show as kulang. Staff submit and sign; the
//   owner approves in Para sa iyo and the adjustments post as "Bilang CNT-…".
//   Quick count (zero check, "May natira pa ba?") and the closing top-5: post at once.
//   Balance: expected = last count + every movement since; it must equal the system's shelf.
//   Write-off: reason, optional photo, staff signs; the stock moves; over 1% → the owner.

import { chargeCountShort } from "../payable/charges.js";
import type { ApiError } from "@sam-store/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { adjustForCount, InsufficientStockError, releaseForTrip, type TripLeg } from "../domain/movements.js";
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
const productSelect = { id: true, name: true, stockBaseUnit: true, stockBaseQuantity: true, costMinor: true } as const;
type P = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

const qtyText = (p: P, qty: number) => (isLooseP(p) ? formatKilos(qty) : `${qty}`);

/** Post every counted line's difference as COUNT_ADJUST, inside the caller's transaction. */
async function postCount(tx: Tx, storeId: string, countId: string, decidedById: string) {
  const count = await tx.stockCount.findUniqueOrThrow({ where: { id: countId }, include: { lines: { include: { product: { select: productSelect } } } } });
  for (const l of count.lines) {
    if (l.countedQty === null || l.expectedQty === null) continue;
    const delta = l.countedQty - l.expectedQty;
    if (delta !== 0) {
      const leg: TripLeg = { storeId, productId: l.productId, warehouseId: count.locationId, actorId: decidedById, documentType: "COUNT", documentId: count.id, note: `Bilang ${count.docNumber}` };
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

  async start(storeId: string, actor: Actor, input: { locationId?: string; productIds?: string[]; note?: string }) {
    return this.run(async () => {
      if (!OWNERS.includes(actor.role)) throw new StepError(forbidden("Only the owner can start a count"));
      const loc = await this.location(storeId, actor, input.locationId);
      const open = await prisma.stockCount.findFirst({ where: { storeId, locationId: loc.id, status: { in: ["OPEN", "SUBMITTED"] }, kind: { in: ["FULL", "PARTIAL"] } }, select: { docNumber: true } });
      if (open) throw new StepError(conflict(`There is still an open count here (${open.docNumber}) — finish it first`));
      const chosen = (input.productIds ?? []).filter(Boolean);
      const products = chosen.length
        ? await prisma.product.findMany({ where: { storeId, id: { in: chosen }, isActive: true }, select: { id: true } })
        : await prisma.product.findMany({ where: { storeId, isActive: true, stockLevels: { some: { warehouseId: loc.id } } }, select: { id: true } });
      if (chosen.length && products.length !== new Set(chosen).size) throw new CountError("Unknown product");
      if (products.length === 0) throw new CountError("No products to count here");
      return prisma.$transaction(async (tx) => {
        const docNumber = await nextDocNumber(tx, storeId, "CNT");
        const c = await tx.stockCount.create({ data: { storeId, docNumber, locationId: loc.id, kind: chosen.length ? "PARTIAL" : "FULL", note: input.note?.trim().slice(0, 200) || null, startedById: actor.userId }, select: { id: true, docNumber: true } });
        await tx.stockCountLine.createMany({ data: products.map((p) => ({ storeId, countId: c.id, productId: p.id })) });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "count.start", entityType: "StockCount", entityId: c.id, after: { locationId: loc.id, lines: products.length } } });
        return { id: c.id, docNumber: c.docNumber, lines: products.length };
      });
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
    return rows.map((c) => ({ id: c.id, docNumber: c.docNumber, kind: c.kind, status: c.status, location: c.location.name, locationId: c.locationId, lines: c._count.lines, startedAt: c.startedAt, kulangValueMinor: c.kulangValueMinor, sobraValueMinor: c.sobraValueMinor, approvalId: c.approvalId }));
  }

  /** One count. Staff never see the system's numbers on a blind count that is still open. */
  async get(storeId: string, actor: Actor, id: string) {
    const c = await prisma.stockCount.findFirst({ where: { id, storeId }, include: { location: { select: { name: true } }, lines: { include: { product: { select: productSelect } }, orderBy: { product: { name: "asc" } } } } });
    if (!c) return notFound();
    const refusal = locationRefusal(actor, c.locationId);
    if (refusal) return forbidden(refusal);
    const hide = c.blind && c.status === "OPEN" && !OWNERS.includes(actor.role);
    return {
      ok: true as const,
      value: {
        id: c.id, docNumber: c.docNumber, kind: c.kind, status: c.status, location: c.location.name, locationId: c.locationId, startedAt: c.startedAt,
        kulangValueMinor: c.kulangValueMinor, sobraValueMinor: c.sobraValueMinor, blindHidden: hide,
        lines: c.lines.map((l) => ({
          productId: l.productId, name: l.product.name, loose: isLooseP(l.product), countedQty: l.countedQty, countedAt: l.countedAt,
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
          await tx.stockCountLine.update({ where: { id: line.id }, data: { expectedQty: expected, countedQty: counted, countedAt: new Date(), countedById: actor.userId } });
        }
      }, txOptions());
      const done = await prisma.stockCountLine.count({ where: { countId: id, countedQty: { not: null } } });
      return { id, counted: done, total: c.lines.length };
    });
  }

  /** Submit and sign. Full/partial → the owner's Para sa iyo; quick/closing → posted now. */
  async submit(storeId: string, actor: Actor, id: string, signatures: SignatureInput[] | undefined) {
    return this.run(async () => {
      const c = await prisma.stockCount.findFirst({ where: { id, storeId }, include: { location: { select: { name: true } }, lines: { include: { product: { select: productSelect } } } } });
      if (!c) throw new StepError(notFound());
      const refusal = locationRefusal(actor, c.locationId);
      if (refusal) throw new StepError(forbidden(refusal));
      const missing = c.lines.filter((l) => l.countedQty === null);
      if (missing.length) throw new CountError(`Not counted yet: ${missing.slice(0, 3).map((l) => l.product.name).join(", ")}${missing.length > 3 ? ` +${missing.length - 3} more` : ""}`);
      const results = c.lines.map((l) => ({ l, r: lineResult(l.product, l.expectedQty!, l.countedQty!) }));
      const kulang = -results.filter((x) => x.r.varianceValueMinor < 0).reduce((s, x) => s + x.r.varianceValueMinor, 0);
      const sobra = results.filter((x) => x.r.varianceValueMinor > 0).reduce((s, x) => s + x.r.varianceValueMinor, 0);
      const postNow = c.kind === "QUICK" || c.kind === "CLOSING";
      return prisma.$transaction(async (tx) => {
        const claimed = await tx.stockCount.updateMany({ where: { id, storeId, status: "OPEN" }, data: { status: "SUBMITTED", submittedById: actor.userId, submittedAt: new Date(), kulangValueMinor: kulang, sobraValueMinor: sobra } });
        if (claimed.count === 0) throw new StepError(conflict("This count was already submitted"));
        for (const { l, r } of results) await tx.stockCountLine.update({ where: { id: l.id }, data: { varianceQty: r.varianceQty, varianceValueMinor: r.varianceValueMinor } });
        await captureSignatures(tx, storeId, actor, { documentType: "COUNT", documentId: id, step: "SUBMIT", locationId: c.locationId }, signatures);
        await requireSignatures(tx, storeId, { documentType: "COUNT", documentId: id, step: "SUBMIT" });
        let approvalId: string | null = null;
        if (postNow) {
          await postCount(tx, storeId, id, actor.userId);
        } else {
          const off = results.filter((x) => x.r.varianceQty !== 0);
          approvalId = (await requestApproval(tx, {
            storeId, kind: "COUNT", documentType: "COUNT", documentId: id, locationId: c.locationId,
            summary: `Count ${c.docNumber} at ${c.location.name}: ${c.lines.length} items, ${off.length} short/over. Short ₱${(kulang / 100).toFixed(2)}, over ₱${(sobra / 100).toFixed(2)}.${off.length ? ` E.g.: ${off.slice(0, 3).map((x) => `${x.l.product.name} ${x.r.varianceQty > 0 ? "+" : ""}${qtyText(x.l.product, x.r.varianceQty)}`).join(", ")}.` : ""} Approve to post it.`,
            detail: { kulangValueMinor: kulang, sobraValueMinor: sobra, lines: c.lines.length },
            requestedById: actor.userId,
          })).id;
          await tx.stockCount.update({ where: { id }, data: { approvalId } });
        }
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "count.submit", entityType: "StockCount", entityId: id, after: { kulangValueMinor: kulang, sobraValueMinor: sobra, posted: postNow } } });
        return { id, docNumber: c.docNumber, status: postNow ? "APPROVED" : "SUBMITTED", approvalId, kulangValueMinor: kulang, sobraValueMinor: sobra };
      }, txOptions(60_000));
    });
  }

  async cancel(storeId: string, actor: Actor, id: string) {
    if (!OWNERS.includes(actor.role)) return forbidden("Only the owner can cancel");
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
        return { id: c.id, docNumber, productId: p.id, expectedQty: expected, countedQty: counted, ...r };
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
