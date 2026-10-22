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
const productSelect = { id: true, name: true, stockBaseUnit: true, stockBaseQuantity: true } as const;

/** Peso value of `qty` stock units at `unitMinor` (loose rice: grams, cost per kilo). */
export function chargeAmount(loose: boolean, qty: number, unitMinor: number): number {
  return loose ? Math.round((qty * unitMinor) / 1000) : qty * unitMinor;
}

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
      const balances = stores.map((s) => {
        const mine = sums.filter((x) => x.locationId === s.id);
        const sum = (k: string) => mine.filter((x) => x.kind === k).reduce((a, x) => a + (x._sum.amountMinor ?? 0), 0);
        return { id: s.id, name: s.name, code: s.code, isMain: s.isDefault, chargesMinor: sum("CHARGE"), paymentsMinor: -sum("PAYMENT"), reversedMinor: sum("REVERSAL"), owesMinor: mine.reduce((a, x) => a + (x._sum.amountMinor ?? 0), 0) };
      });
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
