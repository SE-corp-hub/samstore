// Store payable — what a store owes the main store for rice that left without a record.
//
//   The shortage a count finds at the main store ("Store 1") is charged to the store that took it, at the main
//   store's cost price. The store pays in parts; every entry has a number (SP-000123), a person and a time.
//   A mistake is undone with a reversal, never by deleting. Owner and manager only (it shows cost).
//   Rice charged here is treated as taken/sold by that store: no stock is added to it.

import type { ApiError } from "@sam-store/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { shelfCostFor } from "../domain/shelf-cost.js";
import { isLooseP } from "../domain/counting.js";
import { nextDocNumber, type Actor } from "../people/people.service.js";
import { txOptions } from "../persistence/tx-options.js";
import { chargeAmount } from "./charges.js";
import { varietyOf } from "../domain/resack.js";

export type PayableResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
const invalid = (m: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [m] } });
const conflict = (m: string) => ({ ok: false as const, error: { type: "conflict" as const, message: m } });
const forbidden = (m: string) => ({ ok: false as const, error: { type: "forbidden" as const, message: m } });
const notFound = (m: string) => ({ ok: false as const, error: { type: "not_found" as const, message: m } });

class StepError extends Error {
  constructor(readonly result: { ok: false; error: ApiError }) {
    super("payable step refused");
  }
}

const OWNERS = ["OWNER", "MANAGER", "STORE_OWNER", "PLATFORM_ADMIN"];
const productSelect = { id: true, name: true, variety: true, priceMinor: true, stockBaseUnit: true, stockBaseQuantity: true } as const;

export class PayableService {
  private async run<T>(actor: Actor, fn: () => Promise<T>): Promise<PayableResult<T>> {
    if (!OWNERS.includes(actor.role)) return forbidden("Store payable is for the owner and manager");
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof StepError) return e.result;
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return conflict("Already recorded — refresh the page");
      throw e;
    }
  }

  /** The places that can owe: active, not the Buffer. */
  private async stores(storeId: string) {
    return prisma.warehouse.findMany({ where: { storeId, isActive: true, type: { not: "BUFFER" } }, select: { id: true, name: true, code: true, type: true, isDefault: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
  }

  private async owed(storeId: string, locationId: string): Promise<number> {
    const r = await prisma.storePayableEntry.aggregate({ where: { storeId, locationId }, _sum: { amountMinor: true } });
    return r._sum.amountMinor ?? 0;
  }

  async summary(storeId: string, actor: Actor) {
    return this.run(actor, async () => {
      const stores = await this.stores(storeId);
      const sums = await prisma.storePayableEntry.groupBy({ by: ["locationId", "kind"], where: { storeId }, _sum: { amountMinor: true } });
      const week = Date.now() - 7 * 24 * 3600 * 1000;
      const lastPay = new Map((await prisma.storePayableEntry.groupBy({ by: ["locationId"], where: { storeId, kind: "PAYMENT" }, _max: { createdAt: true } })).map((x) => [x.locationId, x._max.createdAt]));
      const firstCharge = new Map((await prisma.storePayableEntry.groupBy({ by: ["locationId"], where: { storeId, kind: "CHARGE" }, _min: { createdAt: true } })).map((x) => [x.locationId, x._min.createdAt]));
      const lastCount = new Map((await prisma.stockCount.groupBy({ by: ["locationId"], where: { storeId, status: "APPROVED" }, _max: { decidedAt: true } })).map((x) => [x.locationId, x._max.decidedAt]));
      const consign = new Map((await prisma.warehouse.findMany({ where: { storeId }, select: { id: true, consignment: true } })).map((w) => [w.id, w.consignment]));
      const balances = stores.map((s) => {
        const mine = sums.filter((x) => x.locationId === s.id);
        const sum = (k: string) => mine.filter((x) => x.kind === k).reduce((a, x) => a + (x._sum.amountMinor ?? 0), 0);
        return { id: s.id, name: s.name, code: s.code, isMain: s.isDefault, chargesMinor: sum("CHARGE"), paymentsMinor: -sum("PAYMENT"), reversedMinor: sum("REVERSAL"), owesMinor: mine.reduce((a, x) => a + (x._sum.amountMinor ?? 0), 0),
          consignment: consign.get(s.id) === true, lastPaymentAt: lastPay.get(s.id) ?? null, lastCountAt: lastCount.get(s.id) ?? null,
          weeklyDue: false, countDue: false };
      });
      for (const b of balances) {
        if (!b.consignment) continue;
        const since = b.lastPaymentAt ?? firstCharge.get(b.id) ?? null;
        b.weeklyDue = b.owesMinor > 0 && !!since && since.getTime() < week;
        b.countDue = !b.lastCountAt || b.lastCountAt.getTime() < week;
      }
      // Shortages found by approved counts that nobody has been charged for yet.
      const used = new Set((await prisma.storePayableEntry.findMany({ where: { storeId, sourceLineId: { not: null } }, select: { sourceLineId: true } })).map((x) => x.sourceLineId!));
      const lines = await prisma.stockCountLine.findMany({
        where: { storeId, postedQty: { lt: 0 }, count: { status: "APPROVED" } }, orderBy: { countedAt: "desc" }, take: 200,
        select: { id: true, productId: true, postedQty: true, countedAt: true, product: { select: productSelect }, count: { select: { docNumber: true, locationId: true, location: { select: { name: true } } } } },
      });
      const toAssign = [];
      for (const l of lines) {
        if (used.has(l.id)) continue;
        const qty = -(l.postedQty ?? 0);
        const unit = await shelfCostFor(prisma, storeId, l.productId, l.count.locationId);
        const loose = isLooseP(l.product);
        toAssign.push({
          lineId: l.id, countDoc: l.count.docNumber, countedAt: l.countedAt, atId: l.count.locationId, at: l.count.location.name,
          productId: l.productId, name: l.product.name, loose, quantity: qty, unitCostMinor: unit, amountMinor: chargeAmount(loose, qty, unit),
        });
      }
      const rows = await prisma.storePayableEntry.findMany({ where: { storeId }, orderBy: { createdAt: "desc" }, take: 100 });
      const names = new Map(stores.map((s) => [s.id, s.name]));
      const prods = new Map((await prisma.product.findMany({ where: { storeId, id: { in: [...new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))] } }, select: productSelect })).map((p) => [p.id, p]));
      const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
      const reversed = new Set(rows.map((r) => r.reversesId).filter((x): x is string => !!x));
      return {
        stores: balances, toAssign, totalOwesMinor: balances.reduce((a, b) => a + b.owesMinor, 0),
        entries: rows.map((r) => {
          const p = r.productId ? prods.get(r.productId) : undefined;
          return {
            id: r.id, docNumber: r.docNumber, kind: r.kind, locationId: r.locationId, store: names.get(r.locationId) ?? "", amountMinor: r.amountMinor,
            productName: p?.name ?? null, loose: p ? isLooseP(p) : false, quantity: r.quantity, unitCostMinor: r.unitCostMinor, note: r.note,
            by: users.get(r.createdById) ?? null, at: r.createdAt, reversed: reversed.has(r.id), canReverse: (r.kind === "CHARGE" || r.kind === "PAYMENT") && !reversed.has(r.id),
          };
        }),
      };
    });
  }

  /** Charge one count shortage to a store. */
  async chargeFromCount(storeId: string, actor: Actor, input: { lineId?: string; locationId?: string }) {
    return this.run(actor, async () => {
      const line = input.lineId ? await prisma.stockCountLine.findFirst({
        where: { id: input.lineId, storeId, postedQty: { lt: 0 }, count: { status: "APPROVED" } },
        select: { id: true, productId: true, postedQty: true, product: { select: productSelect }, count: { select: { docNumber: true, locationId: true } } },
      }) : null;
      if (!line) throw new StepError(notFound("That shortage was not found"));
      const debtor = (await this.stores(storeId)).find((s) => s.id === input.locationId);
      if (!debtor) throw new StepError(invalid("Choose the store that owes"));
      if (debtor.id === line.count.locationId) throw new StepError(invalid("The store that owes must be a different store from the one that was counted"));
      const qty = -(line.postedQty ?? 0);
      const unit = await shelfCostFor(prisma, storeId, line.productId, line.count.locationId);
      const amount = chargeAmount(isLooseP(line.product), qty, unit);
      return prisma.$transaction(async (tx) => {
        const docNumber = await nextDocNumber(tx, storeId, "SP");
        const e = await tx.storePayableEntry.create({
          data: { storeId, docNumber, locationId: debtor.id, kind: "CHARGE", amountMinor: amount, productId: line.productId, quantity: qty, unitCostMinor: unit, sourceLocationId: line.count.locationId, sourceLineId: line.id, note: `Short found in count ${line.count.docNumber}`, createdById: actor.userId },
          select: { id: true },
        });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "payable.charge", entityType: "StorePayableEntry", entityId: e.id, after: { docNumber, locationId: debtor.id, amountMinor: amount, quantity: qty } } });
        return { id: e.id, docNumber, amountMinor: amount };
      }, txOptions());
    });
  }

  /** Charge a quantity directly (rice that is known to have gone to a store). */
  async chargeManual(storeId: string, actor: Actor, input: { locationId?: string; sourceLocationId?: string; productId?: string; quantity?: unknown; note?: string }) {
    return this.run(actor, async () => {
      const qty = input.quantity;
      if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) throw new StepError(invalid("Enter how many (1 or more; loose rice in grams)"));
      const stores = await this.stores(storeId);
      const debtor = stores.find((s) => s.id === input.locationId);
      if (!debtor) throw new StepError(invalid("Choose the store that owes"));
      const source = stores.find((s) => s.id === (input.sourceLocationId || stores.find((x) => x.isDefault)?.id));
      if (!source) throw new StepError(invalid("Choose the store the rice came from"));
      if (source.id === debtor.id) throw new StepError(invalid("The store that owes must be a different store from the one the rice came from"));
      const product = input.productId ? await prisma.product.findFirst({ where: { id: input.productId, storeId }, select: productSelect }) : null;
      if (!product) throw new StepError(invalid("Unknown product"));
      const unit = await shelfCostFor(prisma, storeId, product.id, source.id);
      const amount = chargeAmount(isLooseP(product), qty, unit);
      if (amount <= 0) throw new StepError(invalid(`${product.name} has no cost price yet — set its cost first`));
      return prisma.$transaction(async (tx) => {
        const docNumber = await nextDocNumber(tx, storeId, "SP");
        const e = await tx.storePayableEntry.create({
          data: { storeId, docNumber, locationId: debtor.id, kind: "CHARGE", amountMinor: amount, productId: product.id, quantity: qty, unitCostMinor: unit, sourceLocationId: source.id, note: input.note?.trim().slice(0, 200) || "Added by hand", createdById: actor.userId },
          select: { id: true },
        });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "payable.charge", entityType: "StorePayableEntry", entityId: e.id, after: { docNumber, locationId: debtor.id, amountMinor: amount, quantity: qty } } });
        return { id: e.id, docNumber, amountMinor: amount };
      }, txOptions());
    });
  }

  /** The store pays (a part, or all). */
  async payment(storeId: string, actor: Actor, input: { locationId?: string; amountMinor?: unknown; note?: string }) {
    return this.run(actor, async () => {
      const amount = input.amountMinor;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) throw new StepError(invalid("Enter the amount paid"));
      const debtor = (await this.stores(storeId)).find((s) => s.id === input.locationId);
      if (!debtor) throw new StepError(invalid("Choose the store that paid"));
      return prisma.$transaction(async (tx) => {
        const owes = (await tx.storePayableEntry.aggregate({ where: { storeId, locationId: debtor.id }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
        if (amount > owes) throw new StepError(conflict(`${debtor.name} owes only ₱${(owes / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}. Enter that or less.`));
        const docNumber = await nextDocNumber(tx, storeId, "SP");
        const e = await tx.storePayableEntry.create({
          data: { storeId, docNumber, locationId: debtor.id, kind: "PAYMENT", amountMinor: -amount, note: input.note?.trim().slice(0, 200) || "Payment received", createdById: actor.userId },
          select: { id: true },
        });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "payable.payment", entityType: "StorePayableEntry", entityId: e.id, after: { docNumber, locationId: debtor.id, amountMinor: amount } } });
        return { id: e.id, docNumber, balanceMinor: owes - amount };
      }, txOptions());
    });
  }

  /** What the rice that left a store since its last sales report is worth at selling price. */
  private async expectedSales(storeId: string, locationId: string) {
    const last = await prisma.storeSalesReport.findFirst({ where: { storeId, locationId }, orderBy: { createdAt: "desc" } });
    const toAt = new Date();
    const first = last ? null : await prisma.storePayableEntry.findFirst({ where: { storeId, locationId, kind: "CHARGE" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
    const fromAt = last?.toAt ?? first?.createdAt ?? new Date(toAt.getTime() - 7 * 24 * 3600 * 1000);
    const rows = await prisma.storePayableEntry.findMany({ where: { storeId, locationId, kind: { in: ["CHARGE", "REVERSAL"] }, productId: { not: null }, createdAt: { gt: fromAt, lte: toAt } }, select: { kind: true, productId: true, quantity: true } });
    const net = new Map<string, number>();
    for (const r of rows) net.set(r.productId!, (net.get(r.productId!) ?? 0) + (r.kind === "CHARGE" ? 1 : -1) * (r.quantity ?? 0));
    const ids = [...net.keys()];
    const prods = new Map((await prisma.product.findMany({ where: { storeId, id: { in: ids } }, select: productSelect })).map((p) => [p.id, p]));
    const prices = new Map((await prisma.locationPrice.findMany({ where: { storeId, warehouseId: locationId, productId: { in: ids } }, select: { productId: true, priceMinor: true } })).map((x) => [x.productId, x.priceMinor]));
    let expected = 0;
    for (const [pid, q] of net) {
      const p = prods.get(pid);
      if (!p || q <= 0) continue;
      expected += chargeAmount(isLooseP(p), q, prices.get(pid) ?? p.priceMinor);
    }
    return { fromAt, toAt, expectedMinor: expected };
  }

  /** The weekly sales check: what the store says it collected against what the rice that left is worth. */
  async salesCheck(storeId: string, actor: Actor, locationId: string | undefined) {
    return this.run(actor, async () => {
      const store = (await this.stores(storeId)).find((s) => s.id === locationId);
      if (!store) throw new StepError(invalid("Choose a store"));
      const now = await this.expectedSales(storeId, store.id);
      const recent = await prisma.storeSalesReport.findMany({ where: { storeId, locationId: store.id }, orderBy: { createdAt: "desc" }, take: 10 });
      return { store: { id: store.id, name: store.name }, ...now, recent: recent.map((r) => ({ id: r.id, fromAt: r.fromAt, toAt: r.toAt, reportedMinor: r.reportedMinor, expectedMinor: r.expectedMinor, differenceMinor: r.reportedMinor - r.expectedMinor, note: r.note })) };
    });
  }

  /** The store says how much it collected for the period. */
  async reportSales(storeId: string, actor: Actor, input: { locationId?: string; reportedMinor?: unknown; note?: string }) {
    return this.run(actor, async () => {
      const amount = input.reportedMinor;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) throw new StepError(invalid("Enter the amount collected"));
      const store = (await this.stores(storeId)).find((s) => s.id === input.locationId);
      if (!store) throw new StepError(invalid("Choose a store"));
      const now = await this.expectedSales(storeId, store.id);
      const r = await prisma.storeSalesReport.create({
        data: { storeId, locationId: store.id, reportedMinor: amount, expectedMinor: now.expectedMinor, fromAt: now.fromAt, toAt: now.toAt, note: input.note?.trim().slice(0, 200) || null, createdById: actor.userId },
        select: { id: true },
      });
      await prisma.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "payable.sales_report", entityType: "StoreSalesReport", entityId: r.id, after: { locationId: store.id, reportedMinor: amount, expectedMinor: now.expectedMinor } } });
      return { id: r.id, differenceMinor: amount - now.expectedMinor };
    });
  }

  /** Undo a charge or a payment that was a mistake: an opposite entry, with the reason. */
  async reverse(storeId: string, actor: Actor, id: string, reason: string | undefined) {
    return this.run(actor, async () => {
      const why = reason?.trim() ?? "";
      if (why.length < 3) throw new StepError(invalid("Enter the reason"));
      const e = await prisma.storePayableEntry.findFirst({ where: { id, storeId } });
      if (!e) throw new StepError(notFound("Entry not found"));
      if (e.kind !== "CHARGE" && e.kind !== "PAYMENT") throw new StepError(conflict("This entry cannot be undone"));
      return prisma.$transaction(async (tx) => {
        if (await tx.storePayableEntry.findFirst({ where: { reversesId: e.id }, select: { id: true } })) throw new StepError(conflict("Already undone"));
        if (e.kind === "CHARGE" && e.orderId && (await tx.storePayableEntry.findFirst({ where: { storeId, orderId: e.orderId, productId: e.productId, kind: "REVERSAL" }, select: { id: true } }))) {
          throw new StepError(conflict("This sale was already voided or partly returned, so its charge cannot be undone by hand"));
        }
        if (e.kind === "CHARGE") {
          const owes = (await tx.storePayableEntry.aggregate({ where: { storeId, locationId: e.locationId }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
          if (owes - e.amountMinor < 0) throw new StepError(conflict("Payments already cover this charge — undo the payment first"));
        }
        const docNumber = await nextDocNumber(tx, storeId, "SP");
        // The count line is free to be charged again (to the right store).
        if (e.sourceLineId) await tx.storePayableEntry.update({ where: { id: e.id }, data: { sourceLineId: null } });
        const r = await tx.storePayableEntry.create({
          data: { storeId, docNumber, locationId: e.locationId, kind: "REVERSAL", amountMinor: -e.amountMinor, productId: e.productId, quantity: e.quantity, unitCostMinor: e.unitCostMinor, reversesId: e.id, note: `Undo ${e.docNumber}: ${why}`.slice(0, 200), createdById: actor.userId },
          select: { id: true },
        });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "payable.reverse", entityType: "StorePayableEntry", entityId: r.id, after: { reverses: e.docNumber, reason: why } } });
        return { id: r.id, docNumber };
      }, txOptions());
    });
  }

  /** Per item: supplied − sold − returned − shortage = should be on the shelf, against what the system says is there. */
  async reconcile(storeId: string, actor: Actor, locationId: string | undefined) {
    return this.run(actor, async () => {
      const store = (await this.stores(storeId)).find((s) => s.id === locationId);
      if (!store) throw new StepError(invalid("Choose a store"));
      const moves = await prisma.stockMovement.groupBy({ by: ["productId", "type", "documentType"], where: { storeId, warehouseId: store.id }, _sum: { delta: true } });
      const levels = await prisma.stockLevel.findMany({ where: { storeId, warehouseId: store.id }, select: { productId: true, quantityOnHand: true } });
      const ids = [...new Set([...moves.map((m) => m.productId), ...levels.map((l) => l.productId)])];
      const prods = new Map((await prisma.product.findMany({ where: { storeId, id: { in: ids } }, select: productSelect })).map((p) => [p.id, p]));
      const charges = await prisma.storePayableEntry.groupBy({ by: ["productId"], where: { storeId, locationId: store.id, kind: { in: ["CHARGE", "REVERSAL"] }, productId: { not: null } }, _sum: { amountMinor: true } });
      const owed = new Map(charges.map((c) => [c.productId!, c._sum.amountMinor ?? 0]));
      const at = (pid: string, types: string[], resack = false) => moves.filter((m) => m.productId === pid && types.includes(m.type) && (m.documentType === "COUNT_RESACK") === resack).reduce((a, m) => a + (m._sum.delta ?? 0), 0);
      const rows = ids.map((pid) => {
        const p = prods.get(pid);
        const supplied = at(pid, ["TRANSFER_IN", "RECEIVE_IN", "STOCK_IN", "RECEIPT"]);
        const sold = Math.abs(at(pid, ["CONSUME"]));
        const returned = at(pid, ["RETURN_IN", "VOID_RESTORE"]);
        const movedBack = Math.abs(at(pid, ["TRANSFER_OUT"]));
        const countFix = at(pid, ["COUNT_ADJUST", "ADJUST"]);
        const resack = at(pid, ["COUNT_ADJUST"], true);
        const onHand = levels.find((l) => l.productId === pid)?.quantityOnHand ?? 0;
        return { productId: pid, name: p?.name ?? "", loose: p ? isLooseP(p) : false, supplied, sold, returned, movedBack, countFix, resack, onHand, costOwedMinor: owed.get(pid) ?? 0 };
      }).filter((r) => r.supplied || r.sold || r.onHand || r.countFix).sort((a, b) => a.name.localeCompare(b.name));
      // The same, added up in kilos per rice variety: sacks, bags and loose kilos together.
      const varieties = new Map<string, { variety: string; suppliedG: number; soldG: number; returnedG: number; movedBackG: number; countFixG: number; onHandG: number }>();
      for (const r of rows) {
        const p = prods.get(r.productId);
        if (!p || (p.stockBaseUnit ?? "").toLowerCase() !== "g" || !p.stockBaseQuantity) continue;
        const g = p.stockBaseQuantity;
        const key = varietyOf(p);
        const v = varieties.get(key) ?? { variety: key, suppliedG: 0, soldG: 0, returnedG: 0, movedBackG: 0, countFixG: 0, onHandG: 0 };
        v.suppliedG += r.supplied * g; v.soldG += r.sold * g; v.returnedG += r.returned * g; v.movedBackG += r.movedBack * g; v.countFixG += r.countFix * g; v.onHandG += r.onHand * g;
        varieties.set(key, v);
      }
      return { store: { id: store.id, name: store.name }, rows, varieties: [...varieties.values()].sort((a, b) => a.variety.localeCompare(b.variety)) };
    });
  }

  /** One store's statement, oldest first, with a running balance — ready to print. */
  async statement(storeId: string, actor: Actor, locationId: string | undefined) {
    return this.run(actor, async () => {
      const store = (await this.stores(storeId)).find((s) => s.id === locationId);
      if (!store) throw new StepError(invalid("Choose a store"));
      const rows = await prisma.storePayableEntry.findMany({ where: { storeId, locationId: store.id }, orderBy: { createdAt: "asc" } });
      const prods = new Map((await prisma.product.findMany({ where: { storeId, id: { in: [...new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))] } }, select: productSelect })).map((p) => [p.id, p]));
      let run = 0;
      return {
        store: { id: store.id, name: store.name }, owesMinor: await this.owed(storeId, store.id),
        entries: rows.map((r) => {
          run += r.amountMinor;
          const p = r.productId ? prods.get(r.productId) : undefined;
          return { docNumber: r.docNumber, kind: r.kind, at: r.createdAt, productName: p?.name ?? null, loose: p ? isLooseP(p) : false, quantity: r.quantity, unitCostMinor: r.unitCostMinor, amountMinor: r.amountMinor, balanceMinor: run, note: r.note };
        }),
      };
    });
  }
}
