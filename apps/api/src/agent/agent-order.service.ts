// Rice Ops M7 — Order ng agent.
//
//   Agent (own phone):  Bagong order → customer, rice, amount, address, preferred store.
//                       Status: Naghihintay. "Mga order ko" shows every status change.
//   Store staff:        Aprubahan → pick where each line comes from; the rice is held
//                       there (an ORDER_RELEASE trip on that location's Ilabas list), or
//                       Tanggihan with a reason. An agent can never approve.
//   Then the M3 flow:   Ilabas (source) → Naihatid (preferred store) → Bayaran: cash,
//                       GCash or utang, for what was actually delivered.
//
// Prices are the preferred store's, frozen when the agent orders. Tenant-scoped; staff
// act only at their own location.

import type { ApiError } from "@sam-store/contracts";
import { Prisma } from "@prisma/client";
import { prisma, PrismaOrderSequenceRepository } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { randomId } from "../persistence/repositories.js";
import { InsufficientStockError } from "../domain/movements.js";
import { formatOrderNumber } from "../domain/order-number.js";
import { toE164 } from "../domain/phone.js";
import { priceAt, priceLine, saleKey, SellingError } from "../domain/selling.js";
import { taxColumnsFor } from "../domain/tax-store.js";
import { AGENT_STATUS_LABEL, agentStatus, amountDue, checkAddress, readyToPay } from "../domain/agent-order.js";
import { limitCheck, saleText } from "../domain/utang.js";
import { prepareTenders, writeTenders } from "../payments/tenders.js";
import { RegisterService } from "../registers/register.service.js";
import { CreditService } from "../credit/credit.service.js";
import { queueSms } from "../sms/sms.service.js";
import { wakeOutbox } from "../notifications/outbox.service.js";
import { TransferFlowService } from "../transfers/transfer-flow.service.js";
import { BentaService } from "../selling/benta.service.js";
import { captureSignatures, locationRefusal, requireSignatures, signatureErrorResult, type Actor, type SignatureInput } from "../people/people.service.js";
import { txOptions } from "../persistence/tx-options.js";

export type AgentResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

class StepError extends Error {
  constructor(readonly result: { ok: false; error: ApiError }) {
    super("agent order step refused");
  }
}
const invalid = (m: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [m] } });
const conflict = (m: string) => ({ ok: false as const, error: { type: "conflict" as const, message: m } });
const forbidden = (m: string) => ({ ok: false as const, error: { type: "forbidden" as const, message: m } });
const notFound = (m = "Hindi makita ang order") => ({ ok: false as const, error: { type: "not_found" as const, message: m } });

const productSelect = { id: true, name: true, sku: true, priceMinor: true, costMinor: true, isActive: true, reviewStatus: true, stockBaseUnit: true, stockBaseQuantity: true } as const;
const orderInclude = {
  items: { select: { id: true, productId: true, productName: true, soldBy: true, quantity: true, grams: true, unitPriceMinor: true, lineTotalMinor: true, enteredAmountMinor: true, sourceLocationId: true } },
  stockTransfers: { select: { id: true, docNumber: true, productId: true, status: true, quantity: true, releasedQty: true, deliveredQty: true, fromWarehouseId: true } },
  sellingLocation: { select: { id: true, name: true } },
} satisfies Prisma.OrderInclude;
type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export interface AgentLineInput { productId?: string; quantity?: unknown; kilos?: unknown; grams?: unknown; amountMinor?: unknown }

const credit = new CreditService();

export class AgentOrderService {
  private readonly sequences = new PrismaOrderSequenceRepository();
  private readonly flow = new TransferFlowService();
  private readonly benta = new BentaService();
  private readonly registers = new RegisterService();

  private async run<T>(fn: () => Promise<T>): Promise<AgentResult<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof StepError) return e.result;
      if (e instanceof SellingError) return invalid(e.message);
      const sig = signatureErrorResult(e);
      if (sig) return sig;
      throw e;
    }
  }

  private view(o: OrderRow, agentName?: string | null) {
    const code = agentStatus({ status: o.status, declineReason: o.declineReason }, o.stockTransfers.map((t) => ({ status: t.status, deliveredQty: t.deliveredQty })));
    return {
      id: o.id, orderNumber: o.orderNumber, status: code, statusLabel: AGENT_STATUS_LABEL[code], totalMinor: o.totalMinor,
      customerName: o.customerName, customerPhone: o.customerPhone, address: o.deliveryAddressLine1, landmark: o.landmark, note: o.notes,
      location: o.sellingLocation, agentName: agentName ?? null, declineReason: o.declineReason, createdAt: o.createdAt, approvedAt: o.approvedAt,
      lines: o.items.map((i) => ({ id: i.id, productId: i.productId, name: i.productName, soldBy: i.soldBy, quantity: i.quantity, grams: i.grams, lineTotalMinor: i.lineTotalMinor, enteredAmountMinor: i.enteredAmountMinor, sourceLocationId: i.sourceLocationId })),
      trips: o.stockTransfers.map((t) => ({ id: t.id, docNumber: t.docNumber, productId: t.productId, status: t.status, releasedQty: t.releasedQty, deliveredQty: t.deliveredQty, fromLocationId: t.fromWarehouseId })),
      readyToPay: o.status === "CONFIRMED" && readyToPay(o.stockTransfers),
    };
  }

  // ─────────────────────────── the agent ───────────────────────────

  async create(
    storeId: string, actor: Actor,
    input: { idempotencyKey?: unknown; locationId?: string; customerId?: string; customerName?: string; customerPhone?: string; address?: unknown; landmark?: string; note?: string; lines?: AgentLineInput[] },
  ) {
    let key: string;
    try {
      key = saleKey(storeId, input.idempotencyKey);
    } catch (e) {
      return invalid((e as Error).message);
    }
    const earlier = await prisma.order.findFirst({ where: { storeId, idempotencyKey: key }, include: orderInclude });
    if (earlier) return { ok: true as const, value: { ...this.view(earlier), replayed: true } };

    return this.run(async () => {
      const loc = input.locationId ? await prisma.warehouse.findFirst({ where: { id: input.locationId, storeId, isActive: true, type: "STORE" }, select: { id: true, name: true } }) : null;
      if (!loc) throw new SellingError("Pumili ng tindahang magdedeliver");
      let address: string;
      try {
        address = checkAddress(input.address);
      } catch (e) {
        throw new SellingError((e as Error).message);
      }
      const lines = Array.isArray(input.lines) ? input.lines : [];
      if (lines.length === 0 || lines.length > 20) throw new SellingError("Ilagay ang bigas na order (1–20)");
      const ids = lines.map((l) => l.productId ?? "");
      if (new Set(ids).size !== ids.length) throw new SellingError("Isang linya lang bawat bigas");

      // The customer: from the list, or a new one by name + mobile (no utang limit — the owner sets that).
      let storeCustomerId: string;
      let customerName: string;
      let customerPhone: string;
      if (input.customerId) {
        const sc = await prisma.storeCustomer.findFirst({ where: { id: input.customerId, storeId }, include: { customer: { select: { name: true, phone: true } } } });
        if (!sc) throw new SellingError("Hindi makita ang customer");
        storeCustomerId = sc.id;
        customerName = sc.customer.name ?? "Customer";
        customerPhone = sc.customer.phone ?? "";
      } else {
        const name = input.customerName?.trim().replace(/\s+/g, " ") ?? "";
        const phone = toE164(input.customerPhone ?? "");
        if (name.length < 2) throw new SellingError("Ilagay ang pangalan ng customer");
        if (!phone) throw new SellingError("Ilagay ang mobile ng customer (09xx xxx xxxx)");
        const sc = await prisma.$transaction(async (tx) => {
          const c = (await tx.customer.findFirst({ where: { phone }, select: { id: true } })) ?? (await tx.customer.create({ data: { name, phone, email: null, passwordHash: null }, select: { id: true } }));
          return tx.storeCustomer.upsert({ where: { storeId_customerId: { storeId, customerId: c.id } }, update: {}, create: { storeId, customerId: c.id }, select: { id: true } });
        });
        storeCustomerId = sc.id;
        customerName = name;
        customerPhone = phone;
      }

      const products = new Map((await prisma.product.findMany({ where: { storeId, id: { in: ids } }, select: productSelect })).map((p) => [p.id, p]));
      const prices = new Map((await prisma.locationPrice.findMany({ where: { storeId, warehouseId: loc.id, productId: { in: ids } }, select: { productId: true, priceMinor: true } })).map((p) => [p.productId, p.priceMinor]));
      const priced = lines.map((l) => {
        const p = products.get(l.productId ?? "");
        if (!p || !p.isActive || p.reviewStatus === "MERGED") throw new SellingError("Hindi mahanap ang bigas — i-refresh");
        return { product: p, ...priceLine(p, priceAt(p.priceMinor, prices.get(p.id)), l) };
      });
      const total = priced.reduce((s, l) => s + l.lineTotalMinor, 0);
      const store = await prisma.store.findUnique({ where: { id: storeId }, include: { settings: true } });
      if (!store) throw new StepError(notFound("Store not found"));
      const taxCols = await taxColumnsFor(storeId, priced.map((l) => ({ productId: l.product.id, lineTotalMinor: l.lineTotalMinor })), { discountMinor: 0, deliveryFeeMinor: 0 });
      const orderNumber = formatOrderNumber(store.slug, await this.sequences.nextOrderSequence(storeId), { prefix: store.settings?.orderNumberPrefix ?? undefined });
      const id = randomId();
      try {
        await prisma.$transaction(async (tx) => {
          await tx.order.create({
            data: {
              id, orderNumber, storeId, status: "RECEIVED", source: "AGENT", currencyCode: store.currencyCode,
              subtotalMinor: total, deliveryFeeMinor: 0, discountMinor: 0, totalMinor: total, ...taxCols,
              snapshot: { source: "agent", lines: priced.map((l) => ({ productId: l.product.id, name: l.product.name, soldBy: l.soldBy, quantity: l.stockQty, grams: l.grams, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor })) } as Prisma.InputJsonValue,
              paymentMethod: "pending", paymentStatus: "PENDING", idempotencyKey: key, cartToken: "",
              customerName, customerPhone, deliveryAddressLine1: address, landmark: input.landmark?.trim().slice(0, 120) || null, notes: input.note?.trim().slice(0, 300) || null,
              storeCustomerId, fulfillmentType: "DELIVERY", deliveryType: "delivery", sellingLocationId: loc.id, occurredAt: new Date(), agentUserId: actor.userId,
            },
          });
          await tx.orderItem.createMany({
            data: priced.map((l) => ({
              orderId: id, storeId, productId: l.product.id, productName: l.product.name, sku: l.product.sku, unitPriceMinor: l.unitPriceMinor,
              quantity: l.stockQty, lineTotalMinor: l.lineTotalMinor, soldBy: l.soldBy, grams: l.grams, enteredAmountMinor: l.enteredAmountMinor,
              unitCostMinor: l.product.costMinor,
            })),
          });
          await tx.orderStatusHistory.create({ data: { orderId: id, storeId, toStatus: "RECEIVED", actorType: "sales_agent", actorId: actor.userId, reason: "Order ng agent — naghihintay" } });
          await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "agent_order.create", entityType: "Order", entityId: id, after: { orderNumber, totalMinor: total, locationId: loc.id } } });
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && JSON.stringify(e.meta?.target ?? "").includes("idempotencyKey")) {
          const won = await prisma.order.findFirstOrThrow({ where: { storeId, idempotencyKey: key }, include: orderInclude });
          return { ...this.view(won), replayed: true };
        }
        throw e;
      }
      await cacheBust(cacheKey("orders", storeId));
      return { ...this.view(await prisma.order.findFirstOrThrow({ where: { id, storeId }, include: orderInclude })), replayed: false };
    });
  }

  /** Mga order ko — only the agent's own orders. */
  async mine(storeId: string, actor: Actor) {
    const rows = await prisma.order.findMany({ where: { storeId, source: "AGENT", agentUserId: actor.userId }, include: orderInclude, orderBy: { createdAt: "desc" }, take: 100 });
    return rows.map((o) => this.view(o));
  }

  // ─────────────────────────── the store ───────────────────────────

  /** Agent orders for this person's location: waiting, in progress, or done (last 30 days). */
  async forStore(storeId: string, actor: Actor, view: string | undefined) {
    if (actor.role === "SALES_AGENT") return [];
    const where: Prisma.OrderWhereInput = {
      storeId, source: "AGENT",
      ...(actor.homeLocationId && !["OWNER", "MANAGER", "PLATFORM_ADMIN"].includes(actor.role) ? { sellingLocationId: actor.homeLocationId } : {}),
      ...(view === "done" ? { status: { in: ["COMPLETED", "CANCELLED"] }, updatedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }
        : view === "active" ? { status: "CONFIRMED" } : { status: "RECEIVED" }),
    };
    const rows = await prisma.order.findMany({ where, include: orderInclude, orderBy: { createdAt: "asc" }, take: 200 });
    const agents = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.agentUserId ?? ""))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((o) => this.view(o, agents.get(o.agentUserId ?? "")));
  }

  private async loadForStaff(storeId: string, actor: Actor, id: string) {
    if (actor.role === "SALES_AGENT") throw new StepError(forbidden("Ang tindahan ang nag-aaprubahan, hindi ang agent"));
    const o = await prisma.order.findFirst({ where: { id, storeId, source: "AGENT" }, include: orderInclude });
    if (!o || !o.sellingLocationId) throw new StepError(notFound());
    const refusal = locationRefusal(actor, o.sellingLocationId);
    if (refusal) throw new StepError(forbidden(refusal));
    return o;
  }

  /** Aprubahan: each line is held where it will come from (default: the preferred store). */
  async approve(storeId: string, actor: Actor, id: string, input: { sources?: { itemId?: string; sourceLocationId?: string }[] }) {
    return this.run(async () => {
      const o = await this.loadForStaff(storeId, actor, id);
      if (o.status !== "RECEIVED") throw new StepError(conflict("Napagpasyahan na ang order na ito"));
      const chosen = new Map((input.sources ?? []).map((s) => [s.itemId ?? "", s.sourceLocationId ?? ""]));
      const sourceIds = [...new Set(o.items.map((i) => chosen.get(i.id) || o.sellingLocationId!))];
      const valid = new Map((await prisma.warehouse.findMany({ where: { storeId, id: { in: sourceIds }, isActive: true }, select: { id: true, name: true } })).map((w) => [w.id, w]));
      if (valid.size !== sourceIds.length) throw new SellingError("Hindi kilalang lokasyon na pagkukunan");
      const releases: { id: string; docNumber: string }[] = [];
      const at = { failing: null as { productId: string; sourceId: string } | null };
      try {
        await prisma.$transaction(async (tx) => {
          const claimed = await tx.order.updateMany({ where: { id, storeId, status: "RECEIVED" }, data: { status: "CONFIRMED", approvedById: actor.userId, approvedAt: new Date() } });
          if (claimed.count === 0) throw new StepError(conflict("Napagpasyahan na ang order na ito"));
          for (const i of o.items) {
            if (!i.productId) continue;
            const src = chosen.get(i.id) || o.sellingLocationId!;
            at.failing = { productId: i.productId, sourceId: src };
            await tx.orderItem.update({ where: { id: i.id }, data: { sourceLocationId: src === o.sellingLocationId ? null : src } });
            releases.push(await this.flow.createOrderRelease(tx, { storeId, orderId: id, productId: i.productId, quantity: i.quantity, sourceLocationId: src, sellingLocationId: o.sellingLocationId!, customerName: o.customerName, actorId: actor.userId }));
          }
          await tx.orderStatusHistory.create({ data: { orderId: id, storeId, fromStatus: "RECEIVED", toStatus: "CONFIRMED", actorType: "staff", actorId: actor.userId, reason: "Inaprubahan ang order ng agent" } });
          await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "agent_order.approve", entityType: "Order", entityId: id, after: { releases: releases.map((r) => r.docNumber) } } });
        }, txOptions());
      } catch (e) {
        if (e instanceof InsufficientStockError && at.failing) {
          throw new StepError(conflict(await this.benta.shortText(storeId, at.failing.productId, o.sellingLocation!, at.failing.sourceId)));
        }
        throw e;
      }
      await cacheBust(cacheKey("orders", storeId));
      return { ...this.view(await prisma.order.findFirstOrThrow({ where: { id, storeId }, include: orderInclude })), releases };
    });
  }

  /** Tanggihan, with a reason the agent will see. */
  async decline(storeId: string, actor: Actor, id: string, reason: string | undefined) {
    return this.run(async () => {
      const why = reason?.trim() ?? "";
      if (why.length < 3) throw new SellingError("Ilagay ang dahilan (makikita ito ng agent)");
      await this.loadForStaff(storeId, actor, id);
      const claimed = await prisma.$transaction(async (tx) => {
        const c = await tx.order.updateMany({ where: { id, storeId, status: "RECEIVED" }, data: { status: "CANCELLED", declineReason: why.slice(0, 200), approvedById: actor.userId, approvedAt: new Date() } });
        if (c.count === 0) return 0;
        await tx.orderStatusHistory.create({ data: { orderId: id, storeId, fromStatus: "RECEIVED", toStatus: "CANCELLED", actorType: "staff", actorId: actor.userId, reason: `Tinanggihan: ${why}` } });
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "agent_order.decline", entityType: "Order", entityId: id, after: { reason: why } } });
        return 1;
      });
      if (!claimed) throw new StepError(conflict("Napagpasyahan na ang order na ito"));
      await cacheBust(cacheKey("orders", storeId));
      return this.view(await prisma.order.findFirstOrThrow({ where: { id, storeId }, include: orderInclude }));
    });
  }

  /** Bayaran: after delivery, for what was delivered — cash, GCash or utang (the customer signs). */
  async pay(
    storeId: string, actor: Actor, id: string,
    input: { method?: string; tenderedMinor?: unknown; reference?: string; signatures?: SignatureInput[] },
  ) {
    return this.run(async () => {
      const o = await this.loadForStaff(storeId, actor, id);
      if (o.status !== "CONFIRMED") throw new StepError(conflict(o.status === "COMPLETED" ? "Bayad na ang order na ito" : "Hindi pa aprubado ang order"));
      if (!readyToPay(o.stockTransfers)) throw new StepError(conflict("Hindi pa naihahatid lahat — tapusin muna ang Naihatid"));
      const delivered = new Map(o.stockTransfers.filter((t) => t.status !== "CANCELLED").map((t) => [t.productId, t.deliveredQty ?? 0]));
      const due = amountDue(o.items.map((i) => ({ soldBy: i.soldBy, unitPriceMinor: i.unitPriceMinor, quantity: i.quantity, lineTotalMinor: i.lineTotalMinor, delivered: delivered.get(i.productId ?? "") ?? 0 })));
      const method = input.method === "gcash" || input.method === "utang" || input.method === "cash" ? input.method : null;
      if (due > 0 && !method) throw new SellingError("Bayad: Cash, GCash o Utang?");
      const sellingLocationId = o.sellingLocationId!;

      if (due === 0) {
        // Nothing was delivered: close the order, nothing to collect.
        await prisma.$transaction(async (tx) => {
          const c = await tx.order.updateMany({ where: { id, storeId, status: "CONFIRMED" }, data: { status: "CANCELLED", paymentStatus: "CANCELLED_REFUND" } });
          if (c.count === 0) throw new StepError(conflict("Nagbago ang order — i-refresh"));
          await tx.orderStatusHistory.create({ data: { orderId: id, storeId, fromStatus: "CONFIRMED", toStatus: "CANCELLED", actorType: "staff", actorId: actor.userId, reason: "Walang naihatid" } });
        });
        return { ...this.view(await prisma.order.findFirstOrThrow({ where: { id, storeId }, include: orderInclude })), dueMinor: 0, changeMinor: 0 };
      }

      if (method === "utang") {
        const sc = o.storeCustomerId ? await prisma.storeCustomer.findFirst({ where: { id: o.storeCustomerId, storeId } }) : null;
        if (!sc?.creditApproved) throw new SellingError(`Wala pang utang limit si ${o.customerName} — mag-cash/GCash, o ipa-set sa may-ari`);
        const limitMinor = await credit.effectiveLimit(storeId, sc);
        if (!limitCheck(sc.creditBalanceMinor, due, limitMinor).ok) throw new StepError(conflict(`Lampas sa utang limit ni ${o.customerName} — mag-cash/GCash, o ipataas sa may-ari ang limit`));
      }
      const code = method === "utang" ? "credit" : method!;
      const prepared = await prepareTenders({
        storeId, orderId: id, targetMinor: due, storeCustomerId: o.storeCustomerId, requireFullCoverage: true,
        tenders: [{ methodCode: code, amountMinor: due, ...(method === "cash" && typeof input.tenderedMinor === "number" ? { tenderedMinor: input.tenderedMinor } : {}), ...(input.reference ? { reference: input.reference } : {}) }],
      });
      if (!prepared.ok) throw new StepError(prepared);
      const plan = prepared.value;
      const registerSessionId = method === "utang" ? null : await this.registers.sessionAt(storeId, sellingLocationId);
      const sent = { smsQueued: false };
      await prisma.$transaction(async (tx) => {
        const c = await tx.order.updateMany({ where: { id, storeId, status: "CONFIRMED" }, data: { status: "COMPLETED", paymentMethod: code, paymentStatus: method === "utang" ? "PENDING" : "COLLECTED", totalMinor: due, registerSessionId } });
        if (c.count === 0) throw new StepError(conflict("Nagbago ang order — i-refresh"));
        if (method === "utang") {
          await captureSignatures(tx, storeId, actor, { documentType: "SALE", documentId: id, step: "UTANG", locationId: sellingLocationId }, (input.signatures ?? []).filter((s) => s.signerKind === "CUSTOMER"));
          await requireSignatures(tx, storeId, { documentType: "SALE", documentId: id, step: "UTANG" });
        }
        try {
          await writeTenders(tx, { storeId, orderId: id, actorId: actor.userId, plan, note: `Bayad sa order ng agent ${o.orderNumber}`, registerSessionId });
        } catch (e) {
          throw new StepError(conflict(e instanceof Error ? e.message : "Hindi natuloy ang bayad"));
        }
        await tx.orderStatusHistory.create({ data: { orderId: id, storeId, fromStatus: "CONFIRMED", toStatus: "COMPLETED", actorType: "staff", actorId: actor.userId, reason: due < o.totalMinor ? `Binayaran ang naihatid lang (${(due / 100).toFixed(2)} ng ${(o.totalMinor / 100).toFixed(2)})` : null } });
        if (method === "utang" && o.storeCustomerId) {
          const bal = await tx.storeCustomer.findUniqueOrThrow({ where: { id: o.storeCustomerId }, select: { creditBalanceMinor: true } });
          const sms = await queueSms(tx, {
            storeId, storeCustomerId: o.storeCustomerId, template: "utang_sale", documentType: "SALE", documentId: id, createdById: actor.userId,
            text: saleText({ customerName: o.customerName, amountMinor: due, items: o.items.map((i) => i.productName), locationName: o.sellingLocation?.name ?? "", at: new Date(), balanceMinor: bal.creditBalanceMinor }),
          });
          sent.smsQueued = sms.status === "QUEUED";
        }
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "agent_order.pay", entityType: "Order", entityId: id, after: { dueMinor: due, method } } });
      }, txOptions());
      if (sent.smsQueued) wakeOutbox();
      await cacheBust(cacheKey("orders", storeId));
      return { ...this.view(await prisma.order.findFirstOrThrow({ where: { id, storeId }, include: orderInclude })), dueMinor: due, changeMinor: plan.changeMinor };
    });
  }
}
