// Rice Ops M3 — trips between locations, signed at every hand-off.
//
//   Lipat (RESTOCK):            request → (approve | auto from WH) → Ilabas → Tanggapin
//   Sale from another location: sale reserves at the source → Ilabas → Naihatid
//                               (refused / partial → Tanggapin pabalik at the source)
//   Ibinalik:                   rice a customer brings back after a sale
//
// Every step: tenant-scoped lookup, location check (staff act only at their home
// location), status claimed with one conditional UPDATE, guarded ledger writes and the
// step's signatures — all in ONE transaction, so a step either happens completely or
// not at all. Short on a trip goes to the owner's "Para sa iyo".

import { bookProfitShare, consignmentMain, reduceForReturn, reverseMoveEntries, takeBackShare } from "../payable/charges.js";
import { manilaDate } from "../domain/reports.js";
import type { ApiError } from "@sam-store/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { recordCostIn, shelfCostFor } from "../domain/shelf-cost.js";
import { coverShortage } from "../domain/buffer.js";
import { addForTrip, deductStock, InsufficientStockError, releaseForTrip, reserveForTrip, transferStock, unreserveForTrip } from "../domain/movements.js";
import {
  checkArrival, checkRelease, checkReturnBack, deliveryOutcome, readBack, receiveOutcome, returnOutcome,
} from "../domain/transfer-flow.js";
import {
  captureSignatures, locationRefusal, nextDocNumber, requestApproval, requireSignatures, signatureErrorResult,
  type Actor, type SignatureInput,
} from "../people/people.service.js";
import { txOptions } from "../persistence/tx-options.js";
import { seesCost } from "../domain/cost-redact.js";

const OWNER_MANAGER = new Set(["OWNER", "MANAGER"]);

/** A one-step move (released and received in the same instant) made today, Manila time. */
const undoable = (t: { releasedAt: Date | null; receivedAt: Date | null; completedAt: Date | null }) =>
  !!t.completedAt && !!t.releasedAt && t.releasedAt.getTime() === t.receivedAt?.getTime() && manilaDate(t.completedAt) === manilaDate(new Date());

export type FlowResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
type Tx = Prisma.TransactionClient;

/** One recent sale a customer return can be tied to. For loose rice the numbers are grams. */
export interface SaleChoice {
  orderId: string; orderNumber: string; at: string; customerName: string | null; paymentMethod: string;
  bought: number; returned: number; left: number; loose: boolean;
}

class StepError extends Error {
  constructor(readonly result: { ok: false; error: ApiError }) {
    super("step refused");
  }
}
const conflict = (message: string) => ({ ok: false as const, error: { type: "conflict" as const, message } });
const invalid = (message: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [message] } });
const notFound = (message = "This transfer was not found") => ({ ok: false as const, error: { type: "not_found" as const, message } });
const forbidden = (message: string) => ({ ok: false as const, error: { type: "forbidden" as const, message } });

const tripInclude = {
  fromWarehouse: { select: { id: true, name: true, code: true, type: true } },
  toWarehouse: { select: { id: true, name: true, code: true, type: true } },
  product: { select: { id: true, name: true, sku: true } },
  kargador: { select: { id: true, name: true } },
  order: { select: { id: true, orderNumber: true, customerName: true, source: true, status: true } },
} satisfies Prisma.StockTransferInclude;

/** Rice Ops M7: an agent order is paid AFTER delivery — undelivered rice is simply not charged (no refund to settle). */
const unpaidAgentOrder = (t: { order: { source: string; status: string } | null }) => !!t.order && t.order.source === "AGENT" && t.order.status !== "COMPLETED";

type Trip = Prisma.StockTransferGetPayload<{ include: typeof tripInclude }>;

const placeName = (w: { name: string; code: string | null }) => w.name;

export type TripView = "ilabas" | "tanggapin" | "naihatid" | "pabalik" | "all";

export class TransferFlowService {
  private async load(storeId: string, id: string): Promise<Trip | null> {
    return prisma.stockTransfer.findFirst({ where: { id, storeId }, include: tripInclude });
  }

  /** Run a step: map signature / stock / state errors to API results. */
  private async step<T>(fn: () => Promise<T>, productName: string, sourceName: string): Promise<FlowResult<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof StepError) return e.result;
      const sig = signatureErrorResult(e);
      if (sig) return sig;
      if (e instanceof InsufficientStockError) {
        return conflict(`Not enough ${productName} at ${sourceName} (short by ${e.shortfall}). Count again or lower the number.`);
      }
      throw e;
    }
  }

  /** Claim a status change atomically; anything else in flight loses. */
  private async claim(tx: Tx, storeId: string, id: string, from: string[], data: Prisma.StockTransferUncheckedUpdateManyInput) {
    const r = await tx.stockTransfer.updateMany({ where: { id, storeId, status: { in: from as never[] } }, data });
    if (r.count === 0) {
      const now = await tx.stockTransfer.findUnique({ where: { id }, select: { status: true } });
      throw new StepError(conflict(`Not allowed anymore: the transfer is ${now?.status ?? "gone"}`));
    }
  }

  // ─────────────────────────── lists for the phone screens ───────────────────────────

  async list(storeId: string, actor: Actor, view: TripView, locationId?: string) {
    const loc = locationId || actor.homeLocationId || undefined;
    if (loc) {
      const refusal = locationRefusal(actor, loc);
      if (refusal) return [];
    }
    const at = (field: "fromWarehouseId" | "toWarehouseId"): Prisma.StockTransferWhereInput =>
      !loc ? {} : field === "fromWarehouseId" ? { fromWarehouseId: loc } : { toWarehouseId: loc };
    let where: Prisma.StockTransferWhereInput;
    switch (view) {
      case "ilabas": where = { status: "APPROVED", ...at("fromWarehouseId") }; break;
      case "tanggapin": where = { status: "IN_TRANSIT", kind: "RESTOCK", ...at("toWarehouseId") }; break;
      case "naihatid": where = { status: "IN_TRANSIT", kind: "ORDER_RELEASE", ...at("toWarehouseId") }; break;
      case "pabalik": where = { status: "RETURNING", ...at("fromWarehouseId") }; break;
      default: where = loc ? { OR: [{ fromWarehouseId: loc }, { toWarehouseId: loc }] } : {};
    }
    const rows = await prisma.stockTransfer.findMany({
      where: { storeId, ...where },
      orderBy: { createdAt: view === "all" ? "desc" : "asc" },
      take: view === "all" ? 100 : 200,
      include: tripInclude,
    });
    return rows.map((t) => ({
      id: t.id, docNumber: t.docNumber, kind: t.kind, status: t.status, quantity: t.quantity,
      reservedQty: t.reservedQty, releasedQty: t.releasedQty, receivedQty: t.receivedQty, deliveredQty: t.deliveredQty,
      returnedQty: t.returnedQty, shortQty: t.shortQty, pendingReturn: t.status === "RETURNING" ? (t.releasedQty ?? 0) - (t.deliveredQty ?? 0) : 0,
      from: t.fromWarehouse, to: t.toWarehouse, product: t.product, kargador: t.kargador, order: t.order,
      customerName: t.customerName, reason: t.reason, createdAt: t.createdAt, releasedAt: t.releasedAt, receivedAt: t.receivedAt,
    }));
  }

  // ─────────────────────────── sale from another location ───────────────────────────

  /**
   * Called inside the sale's own transaction: the selling location's order is served
   * from `sourceLocationId`. Holds the stock at the source and puts the release on the
   * source's Ilabas list. Stock leaves the source only at the signed release.
   */
  async createOrderRelease(
    tx: Tx,
    input: { storeId: string; orderId: string; productId: string; quantity: number; sourceLocationId: string; sellingLocationId: string; customerName: string; actorId: string },
  ): Promise<{ id: string; docNumber: string }> {
    const docNumber = await nextDocNumber(tx, input.storeId, "REL");
    const t = await tx.stockTransfer.create({
      data: {
        storeId: input.storeId, kind: "ORDER_RELEASE", docNumber, orderId: input.orderId,
        fromWarehouseId: input.sourceLocationId, toWarehouseId: input.sellingLocationId,
        productId: input.productId, quantity: input.quantity, status: "APPROVED",
        requestedById: input.actorId, approvedById: input.actorId, reservedQty: input.quantity,
        customerName: input.customerName.slice(0, 80) || null, reason: "Sale from another location",
      },
      select: { id: true },
    });
    await reserveForTrip(tx, {
      storeId: input.storeId, productId: input.productId, warehouseId: input.sourceLocationId, actorId: input.actorId,
      documentType: "RELEASE", documentId: t.id, note: `hold for ${docNumber}`,
    }, input.quantity);
    return { id: t.id, docNumber };
  }

  // ─────────────────────────── Ilabas ───────────────────────────

  async release(
    storeId: string, actor: Actor, id: string,
    input: { quantity?: unknown; kargadorId?: string; signatures?: SignatureInput[] },
  ): Promise<FlowResult<{ id: string; status: string; releasedQty: number }>> {
    const t = await this.load(storeId, id);
    if (!t) return notFound();
    const refusal = locationRefusal(actor, t.fromWarehouseId);
    if (refusal) return forbidden(refusal);
    const qty = input.quantity ?? t.quantity;
    const check = checkRelease(t.quantity, qty);
    if (!check.ok) return invalid(check.error);
    const kargador = input.kargadorId
      ? await prisma.kargador.findFirst({ where: { id: input.kargadorId, storeId, isActive: true }, select: { id: true } })
      : null;
    if (!kargador) return invalid("Choose the porter who will carry it");
    const released = qty as number;
    const docType = t.kind === "ORDER_RELEASE" ? "RELEASE" : "TRANSFER";

    return this.step(async () => {
      await prisma.$transaction(async (tx) => {
        await this.claim(tx, storeId, id, ["APPROVED"], {
          status: "IN_TRANSIT", releasedQty: released, reservedQty: 0, kargadorId: kargador.id,
          releasedAt: new Date(), releasedById: actor.userId,
        });
        await captureSignatures(tx, storeId, actor, { documentType: docType, documentId: id, step: "RELEASE", locationId: t.fromWarehouseId }, input.signatures);
        await requireSignatures(tx, storeId, { documentType: docType, documentId: id, step: "RELEASE" }, { kargador: true });
        // Signatures must name THIS trip's kargador.
        const k = await tx.signature.count({ where: { storeId, documentType: docType, documentId: id, step: "RELEASE", signerKind: "KARGADOR", kargadorId: kargador.id } });
        if (k === 0) throw new StepError(invalid("The porter who signs must be the one carrying it"));
        await releaseForTrip(tx, {
          storeId, productId: t.productId, warehouseId: t.fromWarehouseId, actorId: actor.userId,
          documentType: docType, documentId: id, note: t.docNumber ?? null,
        }, t.reservedQty, released);
        await tx.auditLog.create({
          data: { storeId, actorType: "USER", actorId: actor.userId, action: "transfer.release", entityType: "StockTransfer", entityId: id, after: { released, requested: t.quantity, kargadorId: kargador.id } },
        });
      }, txOptions());
      return { id, status: "IN_TRANSIT", releasedQty: released };
    }, t.product.name, placeName(t.fromWarehouse));
  }

  // ─────────────────────────── Tanggapin (restock) ───────────────────────────

  async receive(
    storeId: string, actor: Actor, id: string,
    input: { quantity?: unknown; signatures?: SignatureInput[] },
  ): Promise<FlowResult<{ id: string; status: string; receivedQty: number; shortQty: number; approvalId: string | null }>> {
    const t = await this.load(storeId, id);
    if (!t) return notFound();
    if (t.kind !== "RESTOCK") return conflict("A sale is finished with Delivered, not Receive");
    const refusal = locationRefusal(actor, t.toWarehouseId);
    if (refusal) return forbidden(refusal);
    const released = t.releasedQty ?? 0;
    const check = checkArrival(released, input.quantity);
    if (!check.ok) return invalid(check.error);
    const received = input.quantity as number;
    const { short } = receiveOutcome(released, received);

    return this.step(async () => {
      let approvalId: string | null = null;
      await prisma.$transaction(async (tx) => {
        await this.claim(tx, storeId, id, ["IN_TRANSIT"], {
          status: "COMPLETED", receivedQty: received, shortQty: short, receivedAt: new Date(), receivedById: actor.userId, completedAt: new Date(),
        });
        await captureSignatures(tx, storeId, actor, { documentType: "TRANSFER", documentId: id, step: "RECEIVE", locationId: t.toWarehouseId }, input.signatures);
        await requireSignatures(tx, storeId, { documentType: "TRANSFER", documentId: id, step: "RECEIVE" }, { kargador: !!t.kargadorId });
        // The stock brings the cost of the shelf it left (matters only when the store counts cost per location).
        await recordCostIn(tx, { storeId, productId: t.productId, warehouseId: t.toWarehouseId }, received, await shelfCostFor(tx, storeId, t.productId, t.fromWarehouseId));
        await addForTrip(tx, {
          storeId, productId: t.productId, warehouseId: t.toWarehouseId, actorId: actor.userId,
          documentType: "TRANSFER", documentId: id, note: t.docNumber ?? null,
        }, received, "RECEIVE_IN");
        // Store 1 takes rice from Store 2: Store 1 owes Store 2 its profit on what arrived (none on rice lost on the road).
        const shareRef = { storeId, fromId: t.fromWarehouseId, toId: t.toWarehouseId, productId: t.productId, quantity: received, actorId: actor.userId, ref: t.docNumber ?? "move", transferId: id };
        await bookProfitShare(tx, shareRef);
        await takeBackShare(tx, shareRef);
        if (short > 0) {
          approvalId = (await requestApproval(tx, {
            storeId, kind: "TRANSIT_SHORT", documentType: "TRANSFER", documentId: id, locationId: t.toWarehouseId,
            summary: `Short on transfer ${t.docNumber ?? ""}: ${short} × ${t.product.name} (${released} released at ${t.fromWarehouse.name}, ${received} arrived at ${t.toWarehouse.name}${t.kargador ? `, carried by ${t.kargador.name}` : ""}).`,
            detail: { released, received, short, kargadorId: t.kargadorId },
            requestedById: actor.userId,
          })).id;
        }
        await tx.auditLog.create({
          data: { storeId, actorType: "USER", actorId: actor.userId, action: "transfer.receive", entityType: "StockTransfer", entityId: id, after: { released, received, short } },
        });
      }, txOptions());
      return { id, status: "COMPLETED", receivedQty: received, shortQty: short, approvalId };
    }, t.product.name, placeName(t.fromWarehouse));
  }

  // ─────────────────────────── Naihatid (sale delivered) ───────────────────────────

  async deliver(
    storeId: string, actor: Actor, id: string,
    input: { quantity?: unknown; note?: string; signatures?: SignatureInput[] },
  ): Promise<FlowResult<{ id: string; status: string; deliveredQty: number; pendingReturn: number; approvalId: string | null }>> {
    const t = await this.load(storeId, id);
    if (!t) return notFound();
    if (t.kind !== "ORDER_RELEASE") return conflict("A transfer is finished with Receive");
    const refusal = locationRefusal(actor, t.toWarehouseId);
    if (refusal) return forbidden(refusal);
    const released = t.releasedQty ?? 0;
    const check = checkArrival(released, input.quantity);
    if (!check.ok) return invalid(check.error);
    const delivered = input.quantity as number;
    const { pendingReturn, nextStatus } = deliveryOutcome(released, delivered);
    const note = input.note?.trim() ?? "";
    if (pendingReturn > 0 && note.length < 3) return invalid("Why was not everything delivered? Enter the reason.");
    const customerSigned = (input.signatures ?? []).some((s) => s.signerKind === "CUSTOMER");

    return this.step(async () => {
      let approvalId: string | null = null;
      await prisma.$transaction(async (tx) => {
        await this.claim(tx, storeId, id, ["IN_TRANSIT"], {
          status: nextStatus, deliveredQty: delivered, receivedAt: new Date(), receivedById: actor.userId,
          deliveryNote: note || null, ...(nextStatus === "COMPLETED" ? { completedAt: new Date() } : {}),
        });
        await captureSignatures(tx, storeId, actor, { documentType: "RELEASE", documentId: id, step: "DELIVERED", locationId: t.toWarehouseId }, input.signatures);
        await requireSignatures(tx, storeId, { documentType: "RELEASE", documentId: id, step: "DELIVERED" }, { kargador: true, customer: customerSigned });
        if (pendingReturn > 0 && !unpaidAgentOrder(t)) {
          // The money side of a refused/partial delivery is the owner's call (refund or utang reversal).
          approvalId = (await requestApproval(tx, {
            storeId, kind: "REFUND", documentType: "RELEASE", documentId: id, locationId: t.toWarehouseId,
            summary: `${t.docNumber ?? "Sale"}${t.order ? ` (order ${t.order.orderNumber})` : ""}: ${pendingReturn} × ${t.product.name} not accepted — ${note}. Refund the payment or lower the credit.`,
            detail: { released, delivered, pendingReturn, orderId: t.orderId },
            requestedById: actor.userId,
          })).id;
        }
        await tx.auditLog.create({
          data: { storeId, actorType: "USER", actorId: actor.userId, action: "release.delivered", entityType: "StockTransfer", entityId: id, after: { released, delivered, pendingReturn, note: note || null } },
        });
      }, txOptions());
      return { id, status: nextStatus, deliveredQty: delivered, pendingReturn, approvalId };
    }, t.product.name, placeName(t.fromWarehouse));
  }

  // ─────────────────────────── Tanggapin pabalik ───────────────────────────

  async receiveBack(
    storeId: string, actor: Actor, id: string,
    input: { quantity?: unknown; signatures?: SignatureInput[] },
  ): Promise<FlowResult<{ id: string; status: string; returnedQty: number; shortQty: number; approvalId: string | null }>> {
    const t = await this.load(storeId, id);
    if (!t) return notFound();
    const refusal = locationRefusal(actor, t.fromWarehouseId);
    if (refusal) return forbidden(refusal);
    const pending = (t.releasedQty ?? 0) - (t.deliveredQty ?? 0);
    const check = checkReturnBack(pending, input.quantity);
    if (!check.ok) return invalid(check.error);
    const returned = input.quantity as number;
    const { short } = returnOutcome(pending, returned);

    return this.step(async () => {
      let approvalId: string | null = null;
      await prisma.$transaction(async (tx) => {
        await this.claim(tx, storeId, id, ["RETURNING"], { status: "COMPLETED", returnedQty: returned, shortQty: short, completedAt: new Date() });
        await captureSignatures(tx, storeId, actor, { documentType: "RELEASE", documentId: id, step: "RETURN", locationId: t.fromWarehouseId }, input.signatures);
        await requireSignatures(tx, storeId, { documentType: "RELEASE", documentId: id, step: "RETURN" }, { kargador: true });
        await addForTrip(tx, {
          storeId, productId: t.productId, warehouseId: t.fromWarehouseId, actorId: actor.userId,
          documentType: "RELEASE", documentId: id, note: `return ${t.docNumber ?? ""}`.trim(),
        }, returned, "RETURN_IN");
        if (short > 0) {
          approvalId = (await requestApproval(tx, {
            storeId, kind: "TRANSIT_SHORT", documentType: "RELEASE", documentId: id, locationId: t.fromWarehouseId,
            summary: `Short on return ${t.docNumber ?? ""}: ${short} × ${t.product.name} (${pending} should come back, ${returned} arrived${t.kargador ? `, carried by ${t.kargador.name}` : ""}).`,
            detail: { pending, returned, short, kargadorId: t.kargadorId },
            requestedById: actor.userId,
          })).id;
        }
        await tx.auditLog.create({
          data: { storeId, actorType: "USER", actorId: actor.userId, action: "release.returned", entityType: "StockTransfer", entityId: id, after: { pending, returned, short } },
        });
      }, txOptions());
      return { id, status: "COMPLETED", returnedQty: returned, shortQty: short, approvalId };
    }, t.product.name, placeName(t.fromWarehouse));
  }

  /** Cancel before anything left the source; drops the hold. */
  async cancel(storeId: string, actor: Actor, id: string, reason?: string): Promise<FlowResult<{ id: string; status: string }>> {
    const t = await this.load(storeId, id);
    if (!t) return notFound();
    const why = reason?.trim() ?? "";
    if (why.length < 3) return invalid("Enter the reason for cancelling");
    return this.step(async () => {
      await prisma.$transaction(async (tx) => {
        await this.claim(tx, storeId, id, ["REQUESTED", "APPROVED"], { status: "CANCELLED", reservedQty: 0 });
        await unreserveForTrip(tx, {
          storeId, productId: t.productId, warehouseId: t.fromWarehouseId, actorId: actor.userId,
          documentType: t.kind === "ORDER_RELEASE" ? "RELEASE" : "TRANSFER", documentId: id, note: `cancel: ${why}`,
        }, t.reservedQty);
        if (t.kind === "ORDER_RELEASE" && !unpaidAgentOrder(t)) {
          await requestApproval(tx, {
            storeId, kind: "REFUND", documentType: "RELEASE", documentId: id, locationId: t.toWarehouseId,
            summary: `${t.docNumber ?? "Sale"}${t.order ? ` (order ${t.order.orderNumber})` : ""} cancelled before release: ${t.quantity} × ${t.product.name} — ${why}. Refund the payment or lower the credit.`,
            detail: { quantity: t.quantity, orderId: t.orderId }, requestedById: actor.userId,
          });
        }
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "transfer.cancel", entityType: "StockTransfer", entityId: id, after: { reason: why } } });
      });
      return { id, status: "CANCELLED" };
    }, t.product.name, placeName(t.fromWarehouse));
  }

  // ─────────────────────────── Ibinalik (customer return) ───────────────────────────

  async createReturn(
    storeId: string, actor: Actor,
    input: { locationId?: string; productId?: string; quantity?: unknown; condition?: string; reason?: string; orderId?: string; kargadorId?: string; signatures?: SignatureInput[] },
  ): Promise<FlowResult<{ id: string; docNumber: string; approvalId: string }>> {
    const qty = input.quantity;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) return invalid("Enter how many came back (1 or more)");
    if (input.condition !== "GOOD" && input.condition !== "DAMAGED") return invalid("Choose: good (back to stock) or damaged");
    const reason = input.reason?.trim() ?? "";
    if (reason.length < 3) return invalid("Enter the reason for the return");
    const location = input.locationId ? await prisma.warehouse.findFirst({ where: { id: input.locationId, storeId, isActive: true } }) : null;
    if (!location) return invalid("Choose the location it was returned to");
    const refusal = locationRefusal(actor, location.id);
    if (refusal) return forbidden(refusal);
    const product = input.productId ? await prisma.product.findFirst({ where: { id: input.productId, storeId }, select: { id: true, name: true } }) : null;
    if (!product) return invalid("Unknown product");
    let order: { id: string; orderNumber: string } | null = null;
    if (input.orderId) {
      order = await prisma.order.findFirst({ where: { id: input.orderId, storeId }, select: { id: true, orderNumber: true } });
      if (!order) return invalid("Order not found in this store");
      const sold = await prisma.orderItem.aggregate({ where: { orderId: order.id, productId: product.id }, _sum: { quantity: true } });
      const already = await prisma.stockReturn.aggregate({ where: { storeId, orderId: order.id, productId: product.id }, _sum: { quantity: true } });
      if ((already._sum.quantity ?? 0) + qty > (sold._sum.quantity ?? 0)) return invalid(`Cannot return more than was bought (${sold._sum.quantity ?? 0})`);
    }
    const kargador = input.kargadorId ? await prisma.kargador.findFirst({ where: { id: input.kargadorId, storeId, isActive: true }, select: { id: true } }) : null;
    if (input.kargadorId && !kargador) return invalid("Unknown porter");

    return this.step(async () => {
      let out = { id: "", docNumber: "", approvalId: "" };
      await prisma.$transaction(async (tx) => {
        const docNumber = await nextDocNumber(tx, storeId, "RET");
        const r = await tx.stockReturn.create({
          data: { storeId, docNumber, orderId: order?.id ?? null, locationId: location.id, productId: product.id, quantity: qty, condition: input.condition as "GOOD" | "DAMAGED", reason, kargadorId: kargador?.id ?? null, createdById: actor.userId },
          select: { id: true },
        });
        if (input.condition === "GOOD") {
          await addForTrip(tx, { storeId, productId: product.id, warehouseId: location.id, actorId: actor.userId, documentType: "RETURN", documentId: r.id, note: docNumber }, qty, "RETURN_IN");
          // Good rice back at a consignment store is unsold again: its cost charge comes off.
          if (order && (await consignmentMain(tx, storeId, location.id))) {
            await reduceForReturn(tx, { storeId, orderId: order.id, productId: product.id, quantity: qty, actorId: actor.userId, docNumber });
          }
        }
        const approval = await requestApproval(tx, {
          storeId, kind: "REFUND", documentType: "RETURN", documentId: r.id, locationId: location.id,
          summary: `Returned ${docNumber}: ${qty} × ${product.name} (${input.condition === "GOOD" ? "good, back in stock" : "damaged, cannot be sold"})${order ? ` from order ${order.orderNumber}` : ""} — ${reason}. Refund the payment or lower the credit.`,
          detail: { quantity: qty, condition: input.condition, orderId: order?.id ?? null },
          requestedById: actor.userId,
        });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "stock.return", entityType: "StockReturn", entityId: r.id, after: { quantity: qty, condition: input.condition, locationId: location.id } } });
        out = { id: r.id, docNumber, approvalId: approval.id };
      });
      return out;
    }, product.name, location.name);
  }

  // ─────────────────────────── One-step move (no trip, no signatures) ───────────────────────────

  /** Move rice between two locations now: both counts change, a numbered record is kept. */
  async moveNow(
    storeId: string, actor: Actor,
    input: { fromLocationId?: string; toLocationId?: string; productId?: string; quantity?: unknown; note?: string },
  ): Promise<FlowResult<{ id: string; docNumber: string; profitShareMinor?: number }>> {
    const qty = input.quantity;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) return invalid("Enter how many to move (1 or more)");
    if (!input.fromLocationId || !input.toLocationId) return invalid("Choose where it comes from and where it goes");
    if (input.fromLocationId === input.toLocationId) return invalid("Pick two different places");
    const places = await prisma.warehouse.findMany({ where: { storeId, isActive: true, id: { in: [input.fromLocationId, input.toLocationId] } }, select: { id: true, name: true, code: true, type: true } });
    const from = places.find((w) => w.id === input.fromLocationId);
    const to = places.find((w) => w.id === input.toLocationId);
    if (!from || !to) return invalid("Unknown place");
    // Staff may move rice out of, or into, their own store — not between two other places.
    if (locationRefusal(actor, from.id) && locationRefusal(actor, to.id)) return forbidden(locationRefusal(actor, from.id) ?? "Not your store");
    const product = input.productId ? await prisma.product.findFirst({ where: { id: input.productId, storeId }, select: { id: true, name: true } }) : null;
    if (!product) return invalid("Unknown product");
    return this.step(async () => {
      let out: { id: string; docNumber: string; profitShareMinor?: number } = { id: "", docNumber: "" };
      await prisma.$transaction(async (tx) => {
        const docNumber = await nextDocNumber(tx, storeId, "TR");
        const now = new Date();
        const t = await tx.stockTransfer.create({
          data: {
            storeId, kind: "RESTOCK", docNumber, fromWarehouseId: from.id, toWarehouseId: to.id, productId: product.id, quantity: qty, status: "COMPLETED",
            requestedById: actor.userId, approvedById: actor.userId, releasedQty: qty, receivedQty: qty, releasedAt: now, receivedAt: now, releasedById: actor.userId, receivedById: actor.userId, completedAt: now,
            reason: input.note?.trim().slice(0, 200) || "Moved",
          },
          select: { id: true },
        });
        await recordCostIn(tx, { storeId, productId: product.id, warehouseId: to.id }, qty, await shelfCostFor(tx, storeId, product.id, from.id));
        if (from.type !== "BUFFER") await coverShortage(tx, storeId, { productId: product.id, warehouseId: from.id, needed: qty, actorId: actor.userId, documentType: "TRANSFER", documentId: t.id, reason: `move ${docNumber}` });
        await transferStock(tx, { storeId, productId: product.id, fromWarehouseId: from.id, toWarehouseId: to.id, quantity: qty, actorId: actor.userId, documentType: "TRANSFER", documentId: t.id, note: docNumber, sourceMayGoNegative: from.type === "BUFFER" });
        const shareRef = { storeId, fromId: from.id, toId: to.id, productId: product.id, quantity: qty, actorId: actor.userId, ref: docNumber, transferId: t.id };
        // + Store 1 owes the store its profit, − the share came back. Only for those who see cost (the margin shows it).
        const share = (await bookProfitShare(tx, shareRef)) - (await takeBackShare(tx, shareRef));
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "transfer.move", entityType: "StockTransfer", entityId: t.id, after: { quantity: qty, from: from.name, to: to.name } } });
        out = { id: t.id, docNumber, ...(share && seesCost(actor.role) ? { profitShareMinor: share } : {}) };
      }, txOptions());
      return out;
    }, product.name, from.name);
  }

  /**
   * Undo a one-step move made today: the stock goes back and its profit share (or share taken back) comes off.
   * Refused when the rice is no longer there to send back (sold or moved on).
   */
  async undoMove(storeId: string, actor: Actor, id: string): Promise<FlowResult<{ id: string; status: string }>> {
    const t = await this.load(storeId, id);
    if (!t || t.kind !== "RESTOCK") return notFound();
    if (t.status !== "COMPLETED" || !undoable(t)) return conflict("Only a move made today with Move stock can be undone");
    return this.step(async () => {
      await prisma.$transaction(async (tx) => {
        await this.claim(tx, storeId, id, ["COMPLETED"], { status: "CANCELLED" });
        const ref = `${t.docNumber ?? "move"} undone`;
        await recordCostIn(tx, { storeId, productId: t.productId, warehouseId: t.fromWarehouseId }, t.quantity, await shelfCostFor(tx, storeId, t.productId, t.toWarehouseId));
        try {
          await transferStock(tx, { storeId, productId: t.productId, fromWarehouseId: t.toWarehouseId, toWarehouseId: t.fromWarehouseId, quantity: t.quantity, actorId: actor.userId, documentType: "TRANSFER", documentId: id, note: ref, sourceMayGoNegative: t.toWarehouse.type === "BUFFER" });
        } catch (e) {
          if (e instanceof InsufficientStockError) throw new StepError(conflict(`Only ${t.quantity - e.shortfall} of the ${t.quantity} × ${t.product.name} are still at ${placeName(t.toWarehouse)}, so this move can't be undone. Move the rest back with Move stock instead.`));
          throw e;
        }
        await reverseMoveEntries(tx, storeId, id, actor.userId, ref);
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "transfer.undo_move", entityType: "StockTransfer", entityId: id, after: { quantity: t.quantity } } });
      }, txOptions());
      return { id, status: "CANCELLED" };
    }, t.product.name, placeName(t.toWarehouse));
  }

  /** Recent one-step moves (newest first). */
  async recentMoves(storeId: string, actor: Actor, locationId?: string) {
    const rows = await prisma.stockTransfer.findMany({
      where: { storeId, kind: "RESTOCK", status: { in: ["COMPLETED", "CANCELLED"] }, completedAt: { not: null }, ...(locationId ? { OR: [{ fromWarehouseId: locationId }, { toWarehouseId: locationId }] } : {}) },
      orderBy: { createdAt: "desc" }, take: 30, include: tripInclude,
    });
    // The profit share each move booked (+ owed to the store, − taken back), for those who see cost.
    const shares = new Map<string, number>();
    if (seesCost(actor.role) && rows.length) {
      const entries = await prisma.storePayableEntry.findMany({ where: { storeId, transferId: { in: rows.map((t) => t.id) }, kind: { in: ["PROFIT_SHARE", "SHARE_BACK"] } }, select: { transferId: true, amountMinor: true } });
      for (const e of entries) if (e.transferId) shares.set(e.transferId, (shares.get(e.transferId) ?? 0) - e.amountMinor);
    }
    return rows.map((t) => ({ id: t.id, docNumber: t.docNumber, productName: t.product.name, quantity: t.quantity, from: t.fromWarehouse.name, to: t.toWarehouse.name, note: t.reason, at: t.completedAt ?? t.createdAt, profitShareMinor: shares.get(t.id) ?? null, undone: t.status === "CANCELLED", canUndo: t.status === "COMPLETED" && undoable(t) && OWNER_MANAGER.has(actor.role) }));
  }

  /** Recent customer returns (newest first). */
  async recentReturns(storeId: string, actor: Actor, locationId?: string) {
    const rows = await prisma.stockReturn.findMany({
      where: { storeId, ...(locationId ? { locationId } : {}) }, orderBy: { createdAt: "desc" }, take: 30,
      include: { product: { select: { name: true } }, location: { select: { name: true } }, order: { select: { orderNumber: true } } },
    });
    return rows.map((r) => ({ id: r.id, docNumber: r.docNumber, productName: r.product.name, quantity: r.quantity, condition: r.condition, reason: r.reason, locationName: r.location.name, orderNumber: r.order?.orderNumber ?? null, at: r.createdAt }));
  }

  /**
   * Recent sales at a location that include this product, newest first, so a return can be tied to the sale it
   * came from. A return that names its sale can lower the customer's credit or start a refund, and at a
   * consignment store it takes the cost charge for those kilos off again. Sales with nothing left to return are left out.
   */
  async salesFor(storeId: string, actor: Actor, input: { locationId?: string; productId?: string }): Promise<FlowResult<{ sales: SaleChoice[] }>> {
    if (!input.locationId || !input.productId) return invalid("Choose the store and the product first");
    const refusal = locationRefusal(actor, input.locationId);
    if (refusal) return forbidden(refusal);
    const since = new Date(Date.now() - 60 * 86_400_000);
    const orders = await prisma.order.findMany({
      where: { storeId, sellingLocationId: input.locationId, status: { in: ["COMPLETED", "DELIVERED"] }, createdAt: { gte: since }, items: { some: { productId: input.productId } } },
      orderBy: { createdAt: "desc" }, take: 40,
      select: { id: true, orderNumber: true, createdAt: true, occurredAt: true, customerName: true, paymentMethod: true, items: { where: { productId: input.productId }, select: { quantity: true, grams: true } } },
    });
    const back = await prisma.stockReturn.groupBy({ by: ["orderId"], where: { storeId, productId: input.productId, orderId: { in: orders.map((o) => o.id) } }, _sum: { quantity: true } });
    const returned = new Map<string, number>();
    for (const b of back) if (b.orderId) returned.set(b.orderId, b._sum.quantity ?? 0);
    const sales: SaleChoice[] = [];
    for (const o of orders) {
      const bought = o.items.reduce((n, i) => n + i.quantity, 0);
      const already = returned.get(o.id) ?? 0;
      if (bought - already <= 0) continue;
      sales.push({
        orderId: o.id, orderNumber: o.orderNumber, at: (o.occurredAt ?? o.createdAt).toISOString(), customerName: o.customerName || null,
        paymentMethod: o.paymentMethod, bought, returned: already, left: bought - already, loose: o.items.some((i) => i.grams !== null),
      });
      if (sales.length >= 25) break;
    }
    return { ok: true, value: { sales } };
  }

  // ─────────────────────────── Agent order: stock leaves at approval ───────────────────────────

  /** Inside the approve transaction: take the rice from `sourceLocationId` now and keep a record of it. */
  async takeForOrder(
    tx: Tx,
    input: { storeId: string; orderId: string; productId: string; quantity: number; sourceLocationId: string; sellingLocationId: string; customerName: string; actorId: string },
  ): Promise<{ id: string; docNumber: string }> {
    const docNumber = await nextDocNumber(tx, input.storeId, "REL");
    const now = new Date();
    const t = await tx.stockTransfer.create({
      data: {
        storeId: input.storeId, kind: "ORDER_RELEASE", docNumber, orderId: input.orderId,
        fromWarehouseId: input.sourceLocationId, toWarehouseId: input.sellingLocationId,
        productId: input.productId, quantity: input.quantity, status: "IN_TRANSIT",
        requestedById: input.actorId, approvedById: input.actorId, releasedQty: input.quantity, releasedAt: now, releasedById: input.actorId,
        customerName: input.customerName.slice(0, 80) || null, reason: "Agent order",
      },
      select: { id: true },
    });
    await coverShortage(tx, input.storeId, { productId: input.productId, warehouseId: input.sourceLocationId, needed: input.quantity, actorId: input.actorId, documentType: "RELEASE", documentId: t.id, reason: `agent order ${docNumber}` });
    await deductStock(tx, input.storeId, [{ productId: input.productId, quantity: input.quantity }], { type: "CONSUME", orderId: input.orderId, createdBy: input.actorId, warehouseId: input.sourceLocationId, documentType: "RELEASE", documentId: t.id });
    return { id: t.id, docNumber };
  }

  /** Delivered (all of it) or Not delivered (the stock goes back where it came from). */
  async settleOrderDelivery(storeId: string, actor: Actor, orderId: string, delivered: boolean, note?: string): Promise<FlowResult<{ orderId: string; delivered: boolean }>> {
    const order = await prisma.order.findFirst({ where: { id: orderId, storeId, source: "AGENT" }, select: { id: true, sellingLocationId: true, status: true } });
    if (!order || !order.sellingLocationId) return notFound("Order not found");
    const refusal = locationRefusal(actor, order.sellingLocationId);
    if (refusal) return forbidden(refusal);
    if (order.status !== "CONFIRMED") return conflict("This order is not waiting for delivery");
    const why = note?.trim() ?? "";
    if (!delivered && why.length < 3) return invalid("Why was it not delivered? Enter the reason.");
    return this.step(async () => {
      await prisma.$transaction(async (tx) => {
        const trips = await tx.stockTransfer.findMany({ where: { storeId, orderId, kind: "ORDER_RELEASE", status: "IN_TRANSIT" } });
        if (trips.length === 0) throw new StepError(conflict("Already marked — refresh the page"));
        for (const t of trips) {
          await this.claim(tx, storeId, t.id, ["IN_TRANSIT"], {
            status: "COMPLETED", deliveredQty: delivered ? (t.releasedQty ?? t.quantity) : 0, receivedAt: new Date(), receivedById: actor.userId,
            completedAt: new Date(), deliveryNote: why || null, ...(delivered ? {} : { returnedQty: t.releasedQty ?? t.quantity }),
          });
          if (!delivered) {
            await addForTrip(tx, { storeId, productId: t.productId, warehouseId: t.fromWarehouseId, actorId: actor.userId, documentType: "RELEASE", documentId: t.id, note: `not delivered: ${why}` }, t.releasedQty ?? t.quantity, "RETURN_IN");
          }
        }
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: delivered ? "agent_order.delivered" : "agent_order.not_delivered", entityType: "Order", entityId: orderId, after: { note: why || null } } });
      }, txOptions());
      return { orderId, delivered };
    }, "rice", "the store");
  }

  /** The sentence the phone reads back before signing a step. */
  async readBackFor(storeId: string, id: string, step: "RELEASE" | "RECEIVE" | "DELIVERED" | "RETURN", qty: number, kargadorName?: string | null) {
    const t = await this.load(storeId, id);
    if (!t) return null;
    return readBack(step, {
      qty, product: t.product.name, from: placeName(t.fromWarehouse), to: placeName(t.toWarehouse),
      kargador: kargadorName ?? t.kargador?.name ?? null, customer: t.kind === "ORDER_RELEASE" ? (t.customerName ?? "customer") : null,
    });
  }
}
