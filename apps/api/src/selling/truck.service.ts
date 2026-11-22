// Truck delivery (2026-11-22): one truck that arrived, counted once.
//
// Every good sack that came off the truck ends up in exactly one place:
//   - a pre-order handed straight from the truck (the order becomes the truck store's: the store of the
//     login doing the truck, or the store the owner picked), or
//   - a store's shelf (any store, typed by the owner).
// The save is refused unless, per rice, pre-orders + shelves = good sacks that came.
//
// How it is booked: each store that gets sacks gets a normal Stock in (IN-…, tagged with the truck).
// The truck store's Stock in also covers the handed-out pre-orders: a pre-order took its rice off its
// store's shelf when it was made (it may have gone below zero), so the sacks put back here make that
// shelf right again. The pre-orders are then completed (paid) the usual way.

import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { txOptions } from "../persistence/tx-options.js";
import { deductStock, restoreStock } from "../domain/movements.js";
import { NO_STORE_YET } from "../domain/people.js";
import { isLoose, SellingError } from "../domain/selling.js";
import { formatKilos } from "../domain/weight.js";
import { locationRefusal, nextDocNumber, seesAllStores, signatureErrorResult, type Actor, type SignatureInput } from "../people/people.service.js";
import { freezeLineCosts } from "./settle-sale.js";
import { BentaService, productSelect } from "./benta.service.js";
import type { ApiError } from "@sam-store/contracts";

type Tx = Prisma.TransactionClient;
type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };
const invalid = (m: string): Result<never> => ({ ok: false, error: { type: "validation", errors: [m] } });
const forbidden = (m: string): Result<never> => ({ ok: false, error: { type: "forbidden", message: m } });

export interface TruckLineInput { productId?: string; good?: unknown; damaged?: unknown; unitCostMinor?: unknown }
export interface TruckShelfInput { locationId?: string; productId?: string; quantity?: unknown }
export interface TruckInput {
  /** The store doing the truck: hand-outs become its orders. Store logins: always their own store. */
  locationId?: string;
  /** Where the truck unloaded (shown on the sheet). */
  unloadLocationId?: string;
  purchaseOrderId?: string;
  supplierName?: string;
  note?: string;
  lines?: TruckLineInput[];
  /** Pre-orders handed out from the truck. */
  preorders?: string[];
  shelves?: TruckShelfInput[];
  signatures?: SignatureInput[];
}

/** The truck sheet, as saved. */
export interface TruckSummary {
  sellingId: string; sellingName: string; unloadId: string; unloadName: string;
  purchaseOrder: { id: string; docNumber: string } | null; supplierName: string | null;
  lines: { productId: string; name: string; loose: boolean; good: number; damaged: number; short: number; unitCostMinor: number | null; toCustomers: number }[];
  preorders: { orderId: string; orderNumber: string; customerName: string; fromName: string | null; totalMinor: number; items: { productId: string; name: string; quantity: number }[] }[];
  shelves: { locationId: string; name: string; code: string | null; items: { productId: string; name: string; quantity: number }[] }[];
  stockIns: { locationId: string; docNumber: string }[];
}

const count = (v: unknown, what: string, max = 100_000_000): number => {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) throw new SellingError(`Wrong number for ${what}`);
  return v;
};

export class TruckService {
  private readonly benta = new BentaService();

  /** Owner and managers only (the owner's answer, 2026-11-22). A manager: their own store's trucks only. */
  private refusal(actor: Actor): string | null {
    if (seesAllStores(actor)) return null;
    if (actor.role !== "MANAGER") return "Only the owner or a manager can do a truck delivery";
    return actor.homeLocationId ? null : NO_STORE_YET;
  }

  async finish(storeId: string, actor: Actor, input: TruckInput): Promise<Result<{ id: string; docNumber: string; summary: TruckSummary }>> {
    const no = this.refusal(actor);
    if (no) return forbidden(no);
    try {
      return { ok: true, value: await this.finishOnce(storeId, actor, input) };
    } catch (e) {
      if (e instanceof SellingError) return invalid(e.message);
      const sig = signatureErrorResult(e);
      if (sig) return sig;
      throw e;
    }
  }

  private async finishOnce(storeId: string, actor: Actor, input: TruckInput) {
    const places = await prisma.warehouse.findMany({ where: { storeId, isActive: true, type: { not: "BUFFER" } }, select: { id: true, name: true, code: true, type: true } });
    const place = (id: string | undefined) => places.find((p) => p.id === id);
    const selling = place(actor.homeLocationId ?? input.locationId);
    if (!selling) throw new SellingError("Choose the store doing the truck");
    if (selling.type !== "STORE") throw new SellingError(`${selling.name} cannot sell. Choose a store for the customers' orders.`);
    const unload = place(input.unloadLocationId) ?? selling;
    // 2026-11-22: a manager's truck is their own store's: its supplier order, pre-orders and shelves.
    const mine = (id: string | null | undefined) => !locationRefusal(actor, id);
    if (!mine(selling.id) || !mine(unload.id)) throw new SellingError("You can only take a truck at your own store");

    // What came.
    const rawLines = Array.isArray(input.lines) ? input.lines : [];
    if (rawLines.length === 0 || rawLines.length > 30) throw new SellingError("Enter the rice that came (1–30 kinds)");
    const ids = rawLines.map((l) => l.productId ?? "");
    if (new Set(ids).size !== ids.length) throw new SellingError("Each rice only once");
    const products = new Map((await prisma.product.findMany({ where: { storeId, id: { in: ids }, isActive: true }, select: productSelect })).map((p) => [p.id, p]));
    const po = input.purchaseOrderId
      ? await prisma.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, storeId }, select: { id: true, docNumber: true, supplierName: true, status: true, locationId: true, lines: { select: { id: true, productId: true, quantity: true, receivedQty: true, unitCostMinor: true } } } })
      : null;
    if (input.purchaseOrderId && !po) throw new SellingError("Supplier order not found");
    if (po && !mine(po.locationId)) throw new SellingError(`${po.docNumber} is for another store`);
    if (po && (po.status === "CANCELLED" || po.status === "RECEIVED")) throw new SellingError(`${po.docNumber} is ${po.status === "CANCELLED" ? "cancelled" : "already complete"}`);
    const lines = rawLines.map((l) => {
      const p = products.get(l.productId ?? "");
      if (!p) throw new SellingError("Rice not found");
      const good = count(l.good, p.name);
      const damaged = count(l.damaged, `${p.name} damaged`);
      if (good + damaged === 0) throw new SellingError(`How many ${p.name} came?`);
      const pl = po?.lines.find((x) => x.productId === p.id) ?? null;
      if (po && !pl) throw new SellingError(`${p.name} is not on ${po.docNumber}`);
      const left = pl ? pl.quantity - pl.receivedQty : 0;
      if (pl && good > left) throw new SellingError(`${p.name}: only ${isLoose(p) ? formatKilos(left) : `${left}`} left on ${po!.docNumber}. Enter the extra as a separate Stock in.`);
      const typed = l.unitCostMinor === undefined || l.unitCostMinor === null || l.unitCostMinor === "" ? null : count(l.unitCostMinor, `${p.name} cost`);
      return { product: p, good, damaged, short: pl ? Math.max(0, left - good - damaged) : 0, unitCostMinor: pl ? pl.unitCostMinor : typed, poLineId: pl?.id ?? null };
    });
    const lineOf = new Map(lines.map((l) => [l.product.id, l]));

    // The pre-orders handed out from the truck.
    const preIds = [...new Set((Array.isArray(input.preorders) ? input.preorders : []).filter((x): x is string => typeof x === "string"))];
    const preorders = preIds.length
      ? await prisma.order.findMany({ where: { storeId, id: { in: preIds }, source: "PRE_ORDER", status: "ON_HOLD" }, include: { items: { select: { productId: true, productName: true, variantId: true, quantity: true } }, sellingLocation: { select: { name: true } } } })
      : [];
    if (preorders.length !== preIds.length) throw new SellingError("A pre-order was already completed or cancelled. Open the truck again.");
    for (const o of preorders) if (!mine(o.sellingLocationId)) throw new SellingError(`${o.orderNumber} is another store's pre-order`);
    const toCustomers = new Map<string, number>();
    for (const o of preorders) {
      const fromTruck = o.items.filter((i) => i.productId && lineOf.has(i.productId));
      if (fromTruck.length === 0) throw new SellingError(`${o.orderNumber} (${o.customerName}) has no rice from this truck`);
      for (const i of fromTruck) toCustomers.set(i.productId!, (toCustomers.get(i.productId!) ?? 0) + i.quantity);
    }

    // The shelves.
    const shelves = new Map<string, Map<string, number>>(); // locationId → productId → sacks
    for (const s of Array.isArray(input.shelves) ? input.shelves : []) {
      const loc = place(s.locationId);
      if (!loc) throw new SellingError("Choose a store for each shelf");
      if (!mine(loc.id)) throw new SellingError(`${loc.name} is not your store. Use Move stock to send rice there later.`);
      const p = lineOf.get(s.productId ?? "");
      if (!p) throw new SellingError("That rice is not on this truck");
      const q = count(s.quantity, p.product.name);
      if (q === 0) continue;
      const m = shelves.get(loc.id) ?? new Map<string, number>();
      m.set(p.product.id, (m.get(p.product.id) ?? 0) + q);
      shelves.set(loc.id, m);
    }

    // The one rule: every good sack is in exactly one place.
    for (const l of lines) {
      const onShelves = [...shelves.values()].reduce((a, m) => a + (m.get(l.product.id) ?? 0), 0);
      const given = toCustomers.get(l.product.id) ?? 0;
      const left = l.good - given - onShelves;
      const u = (n: number) => (isLoose(l.product) ? formatKilos(Math.abs(n)) : `${Math.abs(n)}`);
      if (left > 0) throw new SellingError(`${l.product.name}: ${u(left)} still on the truck. Put them on a shelf.`);
      if (left < 0) throw new SellingError(`${l.product.name}: ${u(left)} more than came. Check the numbers.`);
    }

    const supplierName = po?.supplierName ?? (input.supplierName?.trim().slice(0, 80) || null);
    const result = await prisma.$transaction(async (tx) => {
      const docNumber = await nextDocNumber(tx, storeId, "TRK");
      const truck = await tx.truckDelivery.create({
        data: { storeId, docNumber, locationId: selling.id, purchaseOrderId: po?.id ?? null, supplierName, note: input.note?.trim().slice(0, 200) || null, summary: {}, createdById: actor.userId },
        select: { id: true },
      });
      // Handed-out pre-orders become the truck store's (its price stays, its rice now leaves this shelf).
      for (const o of preorders) await this.movePreorder(tx, storeId, actor, o, selling);
      // A Stock in for each store that got sacks (the truck store's includes the pre-orders' sacks).
      const per = new Map<string, Map<string, number>>(shelves);
      if (toCustomers.size) {
        const m = new Map(per.get(selling.id) ?? []);
        for (const [pid, q] of toCustomers) m.set(pid, (m.get(pid) ?? 0) + q);
        per.set(selling.id, m);
      }
      const stockIns: TruckSummary["stockIns"] = [];
      for (const loc of places.filter((p) => per.has(p.id))) {
        const m = per.get(loc.id)!;
        const doc = await this.benta.writeStockIn(tx, storeId, actor, loc.id, {
          supplierName, note: `Truck ${docNumber}`, purchaseOrderId: po?.id ?? null, truckId: truck.id,
          lines: lines.filter((l) => (m.get(l.product.id) ?? 0) > 0).map((l) => ({ product: l.product, quantity: m.get(l.product.id)!, unitCostMinor: l.unitCostMinor, poLineId: l.poLineId })),
        }, input.signatures);
        stockIns.push({ locationId: loc.id, docNumber: doc.docNumber });
      }
      const summary: TruckSummary = {
        sellingId: selling.id, sellingName: selling.name, unloadId: unload.id, unloadName: unload.name,
        purchaseOrder: po ? { id: po.id, docNumber: po.docNumber } : null, supplierName,
        lines: lines.map((l) => ({ productId: l.product.id, name: l.product.name, loose: isLoose(l.product), good: l.good, damaged: l.damaged, short: l.short, unitCostMinor: l.unitCostMinor, toCustomers: toCustomers.get(l.product.id) ?? 0 })),
        preorders: preorders.map((o) => ({
          orderId: o.id, orderNumber: o.orderNumber, customerName: o.customerName ?? "", fromName: o.sellingLocationId && o.sellingLocationId !== selling.id ? o.sellingLocation?.name ?? null : null, totalMinor: o.totalMinor,
          items: o.items.filter((i) => i.productId && lineOf.has(i.productId)).map((i) => ({ productId: i.productId!, name: i.productName, quantity: i.quantity })),
        })),
        shelves: places.filter((p) => shelves.has(p.id)).map((p) => ({
          locationId: p.id, name: p.name, code: p.code,
          items: [...shelves.get(p.id)!].map(([pid, q]) => ({ productId: pid, name: lineOf.get(pid)!.product.name, quantity: q })),
        })),
        stockIns,
      };
      await tx.truckDelivery.update({ where: { id: truck.id }, data: { summary: summary as unknown as Prisma.InputJsonValue } });
      return { id: truck.id, docNumber, summary };
    }, txOptions());
    await cacheBust(cacheKey("products", storeId));
    await cacheBust(cacheKey("orders", storeId));
    return result;
  }

  /** The same as Pre-order → Move store, inside the truck's save. */
  private async movePreorder(tx: Tx, storeId: string, actor: Actor, o: { id: string; sellingLocationId: string | null; items: { productId: string | null; variantId: string | null; quantity: number }[] }, to: { id: string; name: string }) {
    if (o.sellingLocationId === to.id) return;
    const lines = o.items.filter((i) => !!i.productId).map((i) => ({ productId: i.productId!, variantId: i.variantId ?? null, quantity: i.quantity }));
    const moved = await tx.order.updateMany({ where: { id: o.id, status: "ON_HOLD" }, data: { sellingLocationId: to.id } });
    if (moved.count !== 1) throw new SellingError("A pre-order was already completed. Open the truck again.");
    await restoreStock(tx, storeId, lines, { type: "RELEASE", orderId: o.id, createdBy: actor.userId });
    await deductStock(tx, storeId, lines, { type: "CONSUME", orderId: o.id, createdBy: actor.userId, allowBelowZero: true, warehouseId: to.id });
    await freezeLineCosts(tx, { storeId, orderId: o.id, locationId: to.id });
    await tx.orderStatusHistory.create({ data: { orderId: o.id, storeId, fromStatus: "ON_HOLD", toStatus: "ON_HOLD", reason: `given from the truck at ${to.name}`, actorType: "pos", actorId: actor.userId } });
  }

  /** The trucks of the last 60 days, newest first (the sheet to print again). */
  async list(storeId: string, actor: Actor): Promise<Result<{ trucks: { id: string; docNumber: string; createdAt: Date; summary: TruckSummary }[] }>> {
    const no = this.refusal(actor);
    if (no) return forbidden(no);
    const rows = await prisma.truckDelivery.findMany({ where: { storeId, ...(seesAllStores(actor) ? {} : { locationId: actor.homeLocationId ?? "" }), createdAt: { gte: new Date(Date.now() - 60 * 86_400_000) } }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, docNumber: true, createdAt: true, summary: true } });
    return { ok: true, value: { trucks: rows.map((r) => ({ id: r.id, docNumber: r.docNumber, createdAt: r.createdAt, summary: r.summary as unknown as TruckSummary })) } };
  }
}

