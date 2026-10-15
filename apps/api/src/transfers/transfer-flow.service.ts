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

import type { ApiError } from "@sam-store/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { addForTrip, InsufficientStockError, releaseForTrip, reserveForTrip, unreserveForTrip } from "../domain/movements.js";
import {
  checkArrival, checkRelease, checkReturnBack, deliveryOutcome, readBack, receiveOutcome, returnOutcome,
} from "../domain/transfer-flow.js";
import {
  captureSignatures, locationRefusal, nextDocNumber, requestApproval, requireSignatures, signatureErrorResult,
  type Actor, type SignatureInput,
} from "../people/people.service.js";
import { txOptions } from "../persistence/tx-options.js";

export type FlowResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
type Tx = Prisma.TransactionClient;

class StepError extends Error {
  constructor(readonly result: { ok: false; error: ApiError }) {
    super("step refused");
  }
}
const conflict = (message: string) => ({ ok: false as const, error: { type: "conflict" as const, message } });
const invalid = (message: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [message] } });
const notFound = (message = "Hindi makita ang lipat na ito") => ({ ok: false as const, error: { type: "not_found" as const, message } });
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
        return conflict(`Kulang ang ${productName} sa ${sourceName} (kulang ng ${e.shortfall}). Bilangin ulit o bawasan.`);
      }
      throw e;
    }
  }

  /** Claim a status change atomically; anything else in flight loses. */
  private async claim(tx: Tx, storeId: string, id: string, from: string[], data: Prisma.StockTransferUncheckedUpdateManyInput) {
    const r = await tx.stockTransfer.updateMany({ where: { id, storeId, status: { in: from as never[] } }, data });
    if (r.count === 0) {
      const now = await tx.stockTransfer.findUnique({ where: { id }, select: { status: true } });
      throw new StepError(conflict(`Hindi na puwede: ang lipat ay ${now?.status ?? "wala na"}`));
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
        customerName: input.customerName.slice(0, 80) || null, reason: "Benta mula sa ibang lokasyon",
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
    if (!kargador) return invalid("Pumili ng kargador na magdadala");
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
        if (k === 0) throw new StepError(invalid("Ang pumirmang kargador ay dapat ang magdadala"));
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
    if (t.kind !== "RESTOCK") return conflict("Ang benta ay tinatapos sa Naihatid, hindi sa Tanggapin");
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
        await addForTrip(tx, {
          storeId, productId: t.productId, warehouseId: t.toWarehouseId, actorId: actor.userId,
          documentType: "TRANSFER", documentId: id, note: t.docNumber ?? null,
        }, received, "RECEIVE_IN");
        if (short > 0) {
          approvalId = (await requestApproval(tx, {
            storeId, kind: "TRANSIT_SHORT", documentType: "TRANSFER", documentId: id, locationId: t.toWarehouseId,
            summary: `Kulang sa lipat ${t.docNumber ?? ""}: ${short} × ${t.product.name} (${released} inilabas sa ${t.fromWarehouse.name}, ${received} dumating sa ${t.toWarehouse.name}${t.kargador ? `, dala ni ${t.kargador.name}` : ""}).`,
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
    if (t.kind !== "ORDER_RELEASE") return conflict("Ang lipat ay tinatapos sa Tanggapin");
    const refusal = locationRefusal(actor, t.toWarehouseId);
    if (refusal) return forbidden(refusal);
    const released = t.releasedQty ?? 0;
    const check = checkArrival(released, input.quantity);
    if (!check.ok) return invalid(check.error);
    const delivered = input.quantity as number;
    const { pendingReturn, nextStatus } = deliveryOutcome(released, delivered);
    const note = input.note?.trim() ?? "";
    if (pendingReturn > 0 && note.length < 3) return invalid("Bakit hindi lahat naihatid? Ilagay ang dahilan.");
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
            summary: `${t.docNumber ?? "Benta"}${t.order ? ` (order ${t.order.orderNumber})` : ""}: ${pendingReturn} × ${t.product.name} hindi tinanggap — ${note}. Ibalik ang bayad o bawasan ang utang.`,
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
          documentType: "RELEASE", documentId: id, note: `pabalik ${t.docNumber ?? ""}`.trim(),
        }, returned, "RETURN_IN");
        if (short > 0) {
          approvalId = (await requestApproval(tx, {
            storeId, kind: "TRANSIT_SHORT", documentType: "RELEASE", documentId: id, locationId: t.fromWarehouseId,
            summary: `Kulang sa pagbalik ${t.docNumber ?? ""}: ${short} × ${t.product.name} (${pending} dapat bumalik, ${returned} dumating${t.kargador ? `, dala ni ${t.kargador.name}` : ""}).`,
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
    if (why.length < 3) return invalid("Ilagay ang dahilan ng pagkansela");
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
            summary: `${t.docNumber ?? "Benta"}${t.order ? ` (order ${t.order.orderNumber})` : ""} kinansela bago mailabas: ${t.quantity} × ${t.product.name} — ${why}. Ibalik ang bayad o bawasan ang utang.`,
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
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) return invalid("Ilagay kung ilan ang ibinalik (1 pataas)");
    if (input.condition !== "GOOD" && input.condition !== "DAMAGED") return invalid("Piliin: maayos (ibalik sa stock) o sira");
    const reason = input.reason?.trim() ?? "";
    if (reason.length < 3) return invalid("Ilagay ang dahilan ng pagbalik");
    const location = input.locationId ? await prisma.warehouse.findFirst({ where: { id: input.locationId, storeId, isActive: true } }) : null;
    if (!location) return invalid("Pumili ng lokasyon kung saan ibinalik");
    const refusal = locationRefusal(actor, location.id);
    if (refusal) return forbidden(refusal);
    const product = input.productId ? await prisma.product.findFirst({ where: { id: input.productId, storeId }, select: { id: true, name: true } }) : null;
    if (!product) return invalid("Hindi kilalang produkto");
    let order: { id: string; orderNumber: string } | null = null;
    if (input.orderId) {
      order = await prisma.order.findFirst({ where: { id: input.orderId, storeId }, select: { id: true, orderNumber: true } });
      if (!order) return invalid("Hindi makita ang order sa tindahang ito");
      const sold = await prisma.orderItem.aggregate({ where: { orderId: order.id, productId: product.id }, _sum: { quantity: true } });
      const already = await prisma.stockReturn.aggregate({ where: { storeId, orderId: order.id, productId: product.id }, _sum: { quantity: true } });
      if ((already._sum.quantity ?? 0) + qty > (sold._sum.quantity ?? 0)) return invalid(`Hindi puwedeng magbalik nang higit sa nabili (${sold._sum.quantity ?? 0})`);
    }
    const kargador = input.kargadorId ? await prisma.kargador.findFirst({ where: { id: input.kargadorId, storeId, isActive: true }, select: { id: true } }) : null;
    if (input.kargadorId && !kargador) return invalid("Hindi kilalang kargador");

    return this.step(async () => {
      let out = { id: "", docNumber: "", approvalId: "" };
      await prisma.$transaction(async (tx) => {
        const docNumber = await nextDocNumber(tx, storeId, "RET");
        const r = await tx.stockReturn.create({
          data: { storeId, docNumber, orderId: order?.id ?? null, locationId: location.id, productId: product.id, quantity: qty, condition: input.condition as "GOOD" | "DAMAGED", reason, kargadorId: kargador?.id ?? null, createdById: actor.userId },
          select: { id: true },
        });
        await captureSignatures(tx, storeId, actor, { documentType: "RETURN", documentId: r.id, step: "RECEIVE", locationId: location.id }, input.signatures);
        await requireSignatures(tx, storeId, { documentType: "RETURN", documentId: r.id, step: "RECEIVE" }, { kargador: !!kargador });
        if (input.condition === "GOOD") {
          await addForTrip(tx, { storeId, productId: product.id, warehouseId: location.id, actorId: actor.userId, documentType: "RETURN", documentId: r.id, note: docNumber }, qty, "RETURN_IN");
        }
        const approval = await requestApproval(tx, {
          storeId, kind: "REFUND", documentType: "RETURN", documentId: r.id, locationId: location.id,
          summary: `Ibinalik ${docNumber}: ${qty} × ${product.name} (${input.condition === "GOOD" ? "maayos, balik sa stock" : "sira, hindi maibebenta"})${order ? ` mula order ${order.orderNumber}` : ""} — ${reason}. Ibalik ang bayad o bawasan ang utang.`,
          detail: { quantity: qty, condition: input.condition, orderId: order?.id ?? null },
          requestedById: actor.userId,
        });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "stock.return", entityType: "StockReturn", entityId: r.id, after: { quantity: qty, condition: input.condition, locationId: location.id } } });
        out = { id: r.id, docNumber, approvalId: approval.id };
      });
      return out;
    }, product.name, location.name);
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
