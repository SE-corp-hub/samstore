// Rice Ops M4 — Resack: any rice into any rice at one location, signed.
//
//   Simulan (start):  the input leaves the shelf (RESACK_OUT) — it is "nasa resack"
//   Tapusin (finish): the outputs are counted onto the shelf (RESACK_IN); the loss is
//                     weighed; over 1% → the owner's Para sa iyo (the stock still moves)
//   One step:         start + finish together (the common case at the counter)
//   Buksan ang sako:  one sack → loose kilos (a one-step resack with one output)
//   Cancel:           a started job puts its input back (RESACK_RETURN)
//
// Every write is in one transaction with the step's signatures. The outputs carry
// the input's cost, split by weight (domain/resack.ts), so profit stays honest.

import type { ApiError } from "@sam-store/contracts";
import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";
import { bufferIdOf, coverShortage } from "../domain/buffer.js";
import { addForTrip, deductStock, InsufficientStockError, releaseForTrip, type TripLeg } from "../domain/movements.js";
import { gramsOf, planResack, ResackError, valueOf, type ResackPlan } from "../domain/resack.js";
import { formatKilos } from "../domain/weight.js";
import { isKiloItem, kiloCostFrom, rackCostAfter } from "../domain/kilo.js";
import { recordCostIn, shelfCostFor } from "../domain/shelf-cost.js";
import { chargeResackLoss } from "../payable/charges.js";
import {
  captureSignatures, locationRefusal, nextDocNumber, requestApproval, seesAllStores, requireSignatures, signatureErrorResult,
  type Actor, type SignatureInput,
} from "../people/people.service.js";
import { txOptions } from "../persistence/tx-options.js";

export type ResackResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
type Tx = Prisma.TransactionClient;

class StepError extends Error {
  constructor(readonly result: { ok: false; error: ApiError }) {
    super("resack step refused");
  }
}
const invalid = (m: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [m] } });
const conflict = (m: string) => ({ ok: false as const, error: { type: "conflict" as const, message: m } });
const forbidden = (m: string) => ({ ok: false as const, error: { type: "forbidden" as const, message: m } });
const notFound = (m = "This resack was not found") => ({ ok: false as const, error: { type: "not_found" as const, message: m } });

export interface OutputInput {
  productId?: string;
  /** Stock units of the output product: sacks, or grams for loose rice. */
  quantity?: unknown;
}

/** One more rice going in (besides the first). */
interface MoreIn { product: P; quantity: number; grams: number; valueMinor: number }
/** "3 × Sinandomeng 5kg", or "3.5 kg Sinandomeng (per kilo)" for loose rice. */
const amountText = (o: { product: { name: string; stockBaseQuantity: number | null }; quantity: number }) =>
  (o.product.stockBaseQuantity === 1 ? `${formatKilos(o.quantity)} ${o.product.name}` : `${o.quantity} × ${o.product.name}`);

const productSelect = { id: true, name: true, variety: true, stockBaseUnit: true, stockBaseQuantity: true, stockConversionFamily: true, costMinor: true, isActive: true } as const;
type P = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

export class ResackService {
  private async run<T>(fn: () => Promise<T>): Promise<ResackResult<T>> {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof StepError) return e.result;
      if (e instanceof ResackError) return invalid(e.message);
      const sig = signatureErrorResult(e);
      if (sig) return sig;
      if (e instanceof InsufficientStockError) return conflict(`Not enough stock here (short by ${e.shortfall}). Count again or lower the number.`);
      throw e;
    }
  }

  private async location(storeId: string, actor: Actor, locationId: string | undefined) {
    const loc = locationId ? await prisma.warehouse.findFirst({ where: { id: locationId, storeId, isActive: true }, select: { id: true, name: true } }) : null;
    if (!loc) throw new StepError(invalid("Choose a location"));
    const refusal = locationRefusal(actor, loc.id);
    if (refusal) throw new StepError(forbidden(refusal));
    return loc;
  }

  private async products(storeId: string, ids: string[]): Promise<Map<string, P>> {
    const rows = await prisma.product.findMany({ where: { storeId, id: { in: ids } }, select: productSelect });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async kargador(storeId: string, kargadorId: string | undefined) {
    if (!kargadorId) return null;
    const k = await prisma.kargador.findFirst({ where: { id: kargadorId, storeId, isActive: true }, select: { id: true, name: true } });
    if (!k) throw new StepError(invalid("Unknown porter"));
    return k;
  }

  /** More rice going in besides the first: each one known, active and weighed in grams. */
  private moreIns(more: OutputInput[], byId: Map<string, P>): MoreIn[] {
    return more.map((m) => {
      const p = m.productId ? byId.get(m.productId) : undefined;
      if (!p || !p.isActive) throw new ResackError("Unknown rice going in");
      const qty = m.quantity;
      if (typeof qty !== "number") throw new ResackError(`Enter how many ${p.name} go in`);
      return { product: p, quantity: qty, grams: gramsOf(p, qty), valueMinor: valueOf(p, qty) };
    });
  }

  /** Validate outputs against the input (same rice family, weighed in grams) and plan the numbers. */
  private plan(input: P, inputQty: number, outputs: OutputInput[], byId: Map<string, P>, inputValueMinor?: number, more: MoreIn[] = []) {
    if (!Array.isArray(outputs) || outputs.length === 0) throw new ResackError("Enter what came out");
    const outs = outputs.map((o) => {
      const p = o.productId ? byId.get(o.productId) : undefined;
      if (!p || !p.isActive) throw new ResackError("Unknown output product");
      // Any rice into any rice (1 × Sinandomeng 25 kg → 1 × Dinorado 25 kg is a normal
      // resack, marked "Variety change"). The product's conversion-family label is not
      // checked here: it is set in different places with different spellings ("Bigas" by
      // the import, "bigas" or a variety name from the Products page), and a mismatch
      // blocked real resacks. What makes a product resackable is being weighed in grams
      // (gramsOf below).
      const qty = o.quantity;
      if (typeof qty !== "number") throw new ResackError(`Enter the amount of ${p.name}`);
      return { product: p, quantity: qty, grams: gramsOf(p, qty) };
    });
    const ids = outs.map((o) => o.product.id);
    if (new Set(ids).size !== ids.length) throw new ResackError("Each output product can be listed only once");
    const inputGrams = gramsOf(input, inputQty);
    const plan = planResack({
      input: { productId: input.id, name: input.name, variety: input.variety, grams: inputGrams, valueMinor: inputValueMinor ?? valueOf(input, inputQty) },
      moreInputs: more.map((m) => ({ productId: m.product.id, name: m.product.name, variety: m.product.variety, grams: m.grams, valueMinor: m.valueMinor })),
      outputs: outs.map((o) => ({ productId: o.product.id, name: o.product.name, variety: o.product.variety, grams: o.grams })),
    });
    return { outs, plan, inputGrams };
  }

  private leg(storeId: string, productId: string, locationId: string, actor: Actor, jobId: string, note: string): TripLeg {
    return { storeId, productId, warehouseId: locationId, actorId: actor.userId, documentType: "RESACK", documentId: jobId, note };
  }

  /** Inside a transaction: write the finish (outputs, numbers, approval). */
  private async writeFinish(
    tx: Tx, storeId: string, actor: Actor,
    job: { id: string; docNumber: string; locationId: string; inputProductId: string; inputQty: number; inputGrams: number; kargadorId: string | null },
    input: P, locationName: string,
    outs: { product: P; quantity: number; grams: number }[], plan: ResackPlan, signatures: SignatureInput[] | undefined,
    more: MoreIn[] = [],
  ) {
    const claimed = await tx.resackJob.updateMany({
      where: { id: job.id, storeId, status: "STARTED" },
      data: {
        status: "FINISHED", outputGrams: plan.gramsOut, lossGrams: plan.lossGrams, lossBp: plan.lossBp, lossValueMinor: plan.lossValueMinor,
        varietyChange: plan.varietyChange, finishedById: actor.userId, finishedAt: new Date(),
      },
    });
    if (claimed.count === 0) throw new StepError(conflict("This resack is already finished or cancelled"));
    await captureSignatures(tx, storeId, actor, { documentType: "RESACK", documentId: job.id, step: "FINISH", locationId: job.locationId }, signatures);
    await requireSignatures(tx, storeId, { documentType: "RESACK", documentId: job.id, step: "FINISH" }, { kargador: !!job.kargadorId });
    for (const [i, o] of outs.entries()) {
      await tx.resackOutput.create({ data: { storeId, jobId: job.id, productId: o.product.id, quantity: o.quantity, grams: o.grams, valueMinor: plan.outputValuesMinor[i] ?? 0 } });
      await addForTrip(tx, this.leg(storeId, o.product.id, job.locationId, actor, job.id, job.docNumber), o.quantity, "RESACK_IN");
    }
    await chargeResackLoss(tx, {
      storeId, locationId: job.locationId, jobDoc: job.docNumber, productId: input.id, gramsIn: plan.gramsIn, lossGrams: plan.lossGrams, actorId: actor.userId,
      inputs: more.length ? [{ productId: input.id, grams: plan.gramsIn - more.reduce((sum, m) => sum + m.grams, 0) }, ...more.map((m) => ({ productId: m.product.id, grams: m.grams }))] : undefined,
    });
    let approvalId: string | null = null;
    if (plan.needsApproval) {
      approvalId = (await requestApproval(tx, {
        storeId, kind: "LOSS_OVER_TOLERANCE", documentType: "RESACK", documentId: job.id, locationId: job.locationId,
        // formatKilos already ends in "kg"; loose rice reads as its weight, sacks as a count.
        summary: `Resack ${job.docNumber} at ${locationName}: ${[{ product: input, quantity: job.inputQty, grams: 0 }, ...more].map(amountText).join(" + ")} (${formatKilos(plan.gramsIn)}) → ${outs.map(amountText).join(", ")} (${formatKilos(plan.gramsOut)}). Short ${formatKilos(plan.lossGrams)} (${(plan.lossBp / 100).toFixed(2)}%).`,
        detail: { gramsIn: plan.gramsIn, gramsOut: plan.gramsOut, lossGrams: plan.lossGrams, lossBp: plan.lossBp, lossValueMinor: plan.lossValueMinor, kargadorId: job.kargadorId },
        requestedById: actor.userId,
      })).id;
      await tx.resackJob.update({ where: { id: job.id }, data: { approvalId } });
    }
    await tx.auditLog.create({
      data: { storeId, actorType: "USER", actorId: actor.userId, action: "resack.finish", entityType: "ResackJob", entityId: job.id, after: { gramsIn: plan.gramsIn, gramsOut: plan.gramsOut, lossBp: plan.lossBp, varietyChange: plan.varietyChange } },
    });
    return approvalId;
  }

  /** Inside a transaction: create the job and take the input off the shelf. */
  private async writeStart(
    tx: Tx, storeId: string, actor: Actor,
    data: { locationId: string; input: P; inputQty: number; inputGrams: number; kargadorId: string | null; note: string | null; openSack: boolean; more?: MoreIn[] },
    startSignatures: SignatureInput[] | undefined, requireStartSignature: boolean,
  ) {
    const more = data.more ?? [];
    const docNumber = await nextDocNumber(tx, storeId, "RSK");
    const job = await tx.resackJob.create({
      data: {
        storeId, docNumber, locationId: data.locationId, inputProductId: data.input.id, inputQty: data.inputQty,
        // With more rice going in, the job's grams and value are the totals of everything that went in.
        inputGrams: data.inputGrams + more.reduce((sum, m) => sum + m.grams, 0),
        inputValueMinor: valueOf(data.input, data.inputQty) + more.reduce((sum, m) => sum + m.valueMinor, 0), kargadorId: data.kargadorId, note: data.note, openSack: data.openSack, startedById: actor.userId,
      },
      select: { id: true, docNumber: true, locationId: true, inputProductId: true, inputQty: true, inputGrams: true, kargadorId: true },
    });
    if (requireStartSignature) {
      await captureSignatures(tx, storeId, actor, { documentType: "RESACK", documentId: job.id, step: "START", locationId: data.locationId }, startSignatures);
      await requireSignatures(tx, storeId, { documentType: "RESACK", documentId: job.id, step: "START" }, { kargador: !!data.kargadorId });
    }
    // Every rice going in leaves THIS store's shelf (the store the resack is at).
    for (const m of [{ product: data.input, quantity: data.inputQty }, ...more]) {
      const level = await tx.stockLevel.findFirst({ where: { storeId, productId: m.product.id, warehouseId: data.locationId }, select: { id: true } });
      if (!level && !(await bufferIdOf(tx, storeId))) throw new StepError(conflict(`No ${m.product.name} is recorded at this location`));
      await coverShortage(tx, storeId, { productId: m.product.id, warehouseId: data.locationId, needed: m.quantity, actorId: actor.userId, documentType: "RESACK", documentId: job.id, reason: `resack ${docNumber}` });
      await releaseForTrip(tx, this.leg(storeId, m.product.id, data.locationId, actor, job.id, docNumber), 0, m.quantity, "RESACK_OUT");
    }
    for (const m of more) {
      await tx.resackInput.create({ data: { storeId, jobId: job.id, productId: m.product.id, quantity: m.quantity, grams: m.grams, valueMinor: m.valueMinor } });
    }
    await tx.auditLog.create({
      data: { storeId, actorType: "USER", actorId: actor.userId, action: "resack.start", entityType: "ResackJob", entityId: job.id, after: { inputQty: data.inputQty, inputGrams: data.inputGrams, ...(more.length ? { moreInputs: more.map((m) => ({ productId: m.product.id, quantity: m.quantity, grams: m.grams })) } : {}) } },
    });
    return job;
  }

  // ─────────────────────────── public steps ───────────────────────────

  /** One step: start + finish together (the usual case). Also used by Buksan ang sako. */
  async resack(
    storeId: string, actor: Actor,
    input: { locationId?: string; inputProductId?: string; inputQty?: unknown; moreInputs?: OutputInput[]; outputs?: OutputInput[]; kargadorId?: string; note?: string; openSack?: boolean; signatures?: SignatureInput[] },
  ) {
    return this.run(async () => {
      const moreRaw = input.moreInputs ?? [];
      if (input.openSack && moreRaw.length) throw new ResackError("Open a sack: only one rice goes in");
      const loc = await this.location(storeId, actor, input.locationId);
      const kargador = await this.kargador(storeId, input.kargadorId);
      if (!kargador) throw new ResackError("Choose the porter (kargador) who did the resack — only the porter signs");
      const qty = input.inputQty;
      if (typeof qty !== "number") throw new ResackError("Enter how many go in");
      const byId = await this.products(storeId, [input.inputProductId ?? "", ...moreRaw.map((m) => m.productId ?? ""), ...(input.outputs ?? []).map((o) => o.productId ?? "")]);
      const inP = byId.get(input.inputProductId ?? "");
      if (!inP || !inP.isActive) throw new ResackError("Unknown input product");
      const more = this.moreIns(moreRaw, byId);
      const { outs, plan, inputGrams } = this.plan(inP, qty, input.outputs ?? [], byId, undefined, more);
      if (input.openSack && (outs.length !== 1 || outs[0]!.product.stockBaseQuantity !== 1)) {
        throw new ResackError("Open a sack: only one loose (per kilo) product can come out");
      }
      let out = { id: "", docNumber: "", approvalId: null as string | null };
      await prisma.$transaction(async (tx) => {
        const job = await this.writeStart(tx, storeId, actor, { locationId: loc.id, input: inP, inputQty: qty, inputGrams, kargadorId: kargador?.id ?? null, note: input.note?.trim() || null, openSack: !!input.openSack, more }, undefined, false);
        const approvalId = await this.writeFinish(tx, storeId, actor, job, inP, loc.name, outs, plan, input.signatures, more);
        out = { id: job.id, docNumber: job.docNumber, approvalId };
      }, txOptions());
      return { ...out, status: "FINISHED", gramsIn: plan.gramsIn, gramsOut: plan.gramsOut, lossGrams: plan.lossGrams, lossBp: plan.lossBp, needsApproval: plan.needsApproval, varietyChange: plan.varietyChange };
    });
  }

  /**
   * "Open a sack" on POS (sell per kilo, 2026-11-20): one sack of the kilo item's own rice leaves the
   * shelf and its whole weight (25 kg) comes in as kilo rice at the same store. Staff tap it; no porter,
   * no signature and no weighing (owner's choice: a sack counts as its full weight, any gap shows at
   * the closing count). Kept as a finished resack (openSack) so it is on the Resack list and reports.
   * A step sent again (offline queue) is answered once by the Idempotency-Key.
   */
  async openSackForKilos(storeId: string, actor: Actor, input: { locationId?: string; kiloProductId?: string; sackProductId?: string; sacks?: unknown }) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const n = input.sacks === undefined || input.sacks === null ? 1 : input.sacks;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 50) throw new ResackError("Open 1 to 50 sacks at a time");
      const kilo = input.kiloProductId ? await prisma.product.findFirst({ where: { id: input.kiloProductId, storeId }, select: { ...productSelect, kiloOfId: true } }) : null;
      if (!kilo || !kilo.isActive || !isKiloItem(kilo)) throw new ResackError("Choose the kilo rice to fill");
      // The sacks that can fill it: its own sack, then the display rack's (RackSack).
      const rack = await prisma.rackSack.findMany({ where: { storeId, kiloProductId: kilo.id }, orderBy: { createdAt: "asc" }, select: { sackProductId: true } });
      const sources = [...new Set([...(kilo.kiloOfId ? [kilo.kiloOfId] : []), ...rack.map((r) => r.sackProductId)])];
      if (sources.length === 0) throw new ResackError(`${kilo.name} has no sack linked. In Products, choose the sacks that go in it.`);
      const sackId = input.sackProductId || (sources.length === 1 ? sources[0]! : "");
      if (!sackId) throw new ResackError(`Choose which rice goes in ${kilo.name}`);
      if (!sources.includes(sackId)) throw new ResackError(`That rice does not go in ${kilo.name}. In Products, tick it on ${kilo.name} first.`);
      const sack = (await this.products(storeId, [sackId])).get(sackId);
      if (!sack || !sack.isActive) throw new ResackError(`That sack rice is not for sale any more`);
      const grams = gramsOf(sack, n);
      let out = { id: "", docNumber: "" };
      await prisma.$transaction(async (tx) => {
        // The sacks cost what they cost on THIS shelf (a store that counts cost per location), else the product cost.
        const sackCost = await shelfCostFor(tx, storeId, sack.id, loc.id);
        const value = n * sackCost;
        const addCostPerKilo = kiloCostFrom(sackCost, grams / n);
        const docNumber = await nextDocNumber(tx, storeId, "RSK");
        const now = new Date();
        const job = await tx.resackJob.create({
          data: {
            storeId, docNumber, locationId: loc.id, inputProductId: sack.id, inputQty: n, inputGrams: grams, inputValueMinor: value,
            outputGrams: grams, lossGrams: 0, lossBp: 0, lossValueMinor: 0, openSack: true, status: "FINISHED",
            note: "Opened on POS for kilo selling", startedById: actor.userId, finishedById: actor.userId, finishedAt: now,
          },
          select: { id: true, docNumber: true },
        });
        // Like a sale: the sacks the count does not show come off the Buffer (Not counted yet) when there is one,
        // else the store goes below zero. The rice is in the staff's hands, so the next count fixes the number.
        await coverShortage(tx, storeId, { productId: sack.id, warehouseId: loc.id, needed: n, actorId: actor.userId, documentType: "RESACK", documentId: job.id, reason: `open ${n === 1 ? "a sack" : `${n} sacks`} ${docNumber}` });
        await deductStock(tx, storeId, [{ productId: sack.id, quantity: n }], { type: "RESACK_OUT", createdBy: actor.userId, warehouseId: loc.id, documentType: "RESACK", documentId: job.id, allowBelowZero: true });
        // The kilo rice's one cost (the product cost) is shared by every store, so it averages over the kilos
        // at every store, not only here (else a top-up at one store wipes out what the other store's kilos cost).
        const kilosEverywhere = await tx.stockLevel.findMany({ where: { storeId, productId: kilo.id }, select: { quantityOnHand: true } });
        await tx.resackOutput.create({ data: { storeId, jobId: job.id, productId: kilo.id, quantity: grams, grams, valueMinor: value } });
        // A store that counts cost per location: this shelf's own cost blends in the opened sacks (before they land).
        await recordCostIn(tx, { storeId, productId: kilo.id, warehouseId: loc.id }, grams, addCostPerKilo);
        await addForTrip(tx, this.leg(storeId, kilo.id, loc.id, actor, job.id, docNumber), grams, "RESACK_IN");
        // The kilo rice costs what its sacks cost, per kilo (profit and the store payable per kilo sold). A rack
        // holding two rice at one price: the average by weight of what was on it and what came in.
        const onRackGrams = kilosEverywhere.reduce((sum, l) => sum + Math.max(0, l.quantityOnHand), 0);
        const perKilo = rackCostAfter(onRackGrams, kilo.costMinor, grams, addCostPerKilo);
        if (perKilo > 0 && perKilo !== kilo.costMinor) await tx.product.update({ where: { id: kilo.id }, data: { costMinor: perKilo } });
        await tx.auditLog.create({
          data: { storeId, actorType: "USER", actorId: actor.userId, action: "resack.open_sack_pos", entityType: "ResackJob", entityId: job.id, after: { sack: sack.name, sacks: n, kilo: kilo.name, grams, locationId: loc.id } },
        });
        out = job;
      }, txOptions());
      const level = await prisma.stockLevel.findFirst({ where: { storeId, productId: kilo.id, warehouseId: loc.id }, select: { quantityOnHand: true, quantityReserved: true } });
      return { ...out, sackName: sack.name, kiloName: kilo.name, sacks: n, gramsIn: grams, kiloGramsLeft: Math.max(0, (level?.quantityOnHand ?? 0) - (level?.quantityReserved ?? 0)) };
    });
  }

  /** Simulan: take the input off the shelf now; finish later (it shows as "nasa resack"). */
  async start(
    storeId: string, actor: Actor,
    input: { locationId?: string; inputProductId?: string; inputQty?: unknown; kargadorId?: string; note?: string; signatures?: SignatureInput[] },
  ) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const kargador = await this.kargador(storeId, input.kargadorId);
      if (!kargador) throw new ResackError("Choose the porter (kargador) who did the resack — only the porter signs");
      const qty = input.inputQty;
      if (typeof qty !== "number") throw new ResackError("Enter how many go in");
      const byId = await this.products(storeId, [input.inputProductId ?? ""]);
      const inP = byId.get(input.inputProductId ?? "");
      if (!inP || !inP.isActive) throw new ResackError("Unknown input product");
      const inputGrams = gramsOf(inP, qty);
      let out = { id: "", docNumber: "" };
      await prisma.$transaction(async (tx) => {
        const job = await this.writeStart(tx, storeId, actor, { locationId: loc.id, input: inP, inputQty: qty, inputGrams, kargadorId: kargador?.id ?? null, note: input.note?.trim() || null, openSack: false }, input.signatures, true);
        out = { id: job.id, docNumber: job.docNumber };
      }, txOptions());
      return { ...out, status: "STARTED", gramsIn: inputGrams };
    });
  }

  /** Tapusin: count the outputs onto the shelf. Anyone at the job's location can finish it. */
  async finish(storeId: string, actor: Actor, id: string, input: { outputs?: OutputInput[]; signatures?: SignatureInput[] }) {
    return this.run(async () => {
      const job = await prisma.resackJob.findFirst({ where: { id, storeId }, include: { location: { select: { name: true } } } });
      if (!job) throw new StepError(notFound());
      const refusal = locationRefusal(actor, job.locationId);
      if (refusal) throw new StepError(forbidden(refusal));
      if (job.status !== "STARTED") throw new StepError(conflict("This resack is already finished or cancelled"));
      const byId = await this.products(storeId, [job.inputProductId, ...(input.outputs ?? []).map((o) => o.productId ?? "")]);
      const inP = byId.get(job.inputProductId)!;
      // The value is the one recorded at Simulan, so a cost change in between does not move it.
      const { outs, plan } = this.plan(inP, job.inputQty, input.outputs ?? [], byId, job.inputValueMinor);
      let approvalId: string | null = null;
      await prisma.$transaction(async (tx) => {
        approvalId = await this.writeFinish(tx, storeId, actor, job, inP, job.location.name, outs, plan, input.signatures);
      }, txOptions());
      return { id, docNumber: job.docNumber, status: "FINISHED", approvalId, gramsIn: plan.gramsIn, gramsOut: plan.gramsOut, lossGrams: plan.lossGrams, lossBp: plan.lossBp, needsApproval: plan.needsApproval, varietyChange: plan.varietyChange };
    });
  }

  /** Cancel a started job: the input goes back on the shelf. */
  async cancel(storeId: string, actor: Actor, id: string, reason?: string) {
    return this.run(async () => {
      const why = reason?.trim() ?? "";
      if (why.length < 3) throw new ResackError("Enter the reason for cancelling");
      const job = await prisma.resackJob.findFirst({ where: { id, storeId } });
      if (!job) throw new StepError(notFound());
      const refusal = locationRefusal(actor, job.locationId);
      if (refusal) throw new StepError(forbidden(refusal));
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.resackJob.updateMany({ where: { id, storeId, status: "STARTED" }, data: { status: "CANCELLED", cancelReason: why, finishedById: actor.userId } });
        if (claimed.count === 0) throw new StepError(conflict("This resack is already finished or cancelled"));
        await addForTrip(tx, this.leg(storeId, job.inputProductId, job.locationId, actor, id, `cancel ${job.docNumber}: ${why}`), job.inputQty, "RESACK_RETURN");
        await tx.auditLog.create({ data: { storeId, actorType: "USER", actorId: actor.userId, action: "resack.cancel", entityType: "ResackJob", entityId: id, after: { reason: why } } });
      });
      return { id, status: "CANCELLED" };
    });
  }

  /** Jobs at a location: STARTED ones are the rice "nasa resack". */
  async list(storeId: string, actor: Actor, opts: { status?: string; locationId?: string }) {
    const loc = opts.locationId || actor.homeLocationId || undefined;
    if (!loc && !seesAllStores(actor)) return []; // a store login with no store sees no jobs
    if (loc && locationRefusal(actor, loc)) return [];
    const rows = await prisma.resackJob.findMany({
      where: {
        storeId,
        ...(loc ? { locationId: loc } : {}),
        ...(opts.status && opts.status !== "ALL" ? { status: opts.status as "STARTED" } : {}),
      },
      orderBy: { startedAt: "desc" },
      take: 100,
      include: {
        inputProduct: { select: { id: true, name: true } },
        location: { select: { id: true, name: true, code: true } },
        kargador: { select: { id: true, name: true } },
        outputs: { include: { product: { select: { id: true, name: true, soldByWeight: true } } } },
        moreInputs: { include: { product: { select: { id: true, name: true, soldByWeight: true } } } },
      },
    });
    return rows.map((j) => ({
      id: j.id, docNumber: j.docNumber, status: j.status, location: j.location, input: j.inputProduct, inputQty: j.inputQty,
      inputGrams: j.inputGrams, outputGrams: j.outputGrams, lossGrams: j.lossGrams, lossBp: j.lossBp, varietyChange: j.varietyChange,
      openSack: j.openSack, kargador: j.kargador, approvalId: j.approvalId, startedAt: j.startedAt, finishedAt: j.finishedAt,
      outputs: j.outputs.map((o) => ({ product: o.product, quantity: o.quantity, grams: o.grams, valueMinor: o.valueMinor })),
      moreInputs: j.moreInputs.map((m) => ({ product: m.product, quantity: m.quantity, grams: m.grams })),
    }));
  }
}
