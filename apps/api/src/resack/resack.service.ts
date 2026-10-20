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
import { addForTrip, InsufficientStockError, releaseForTrip, type TripLeg } from "../domain/movements.js";
import { gramsOf, planResack, ResackError, valueOf, type ResackPlan } from "../domain/resack.js";
import { formatKilos } from "../domain/weight.js";
import {
  captureSignatures, locationRefusal, nextDocNumber, requestApproval, requireSignatures, signatureErrorResult,
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

  /** Validate outputs against the input (same rice family, weighed in grams) and plan the numbers. */
  private plan(input: P, inputQty: number, outputs: OutputInput[], byId: Map<string, P>, inputValueMinor?: number) {
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
    let approvalId: string | null = null;
    if (plan.needsApproval) {
      approvalId = (await requestApproval(tx, {
        storeId, kind: "LOSS_OVER_TOLERANCE", documentType: "RESACK", documentId: job.id, locationId: job.locationId,
        // formatKilos already ends in "kg"; loose rice reads as its weight, sacks as a count.
        summary: `Resack ${job.docNumber} at ${locationName}: ${job.inputQty} × ${input.name} (${formatKilos(plan.gramsIn)}) → ${outs.map((o) => (o.product.stockBaseQuantity === 1 ? `${formatKilos(o.grams)} ${o.product.name}` : `${o.quantity} × ${o.product.name}`)).join(", ")} (${formatKilos(plan.gramsOut)}). Short ${formatKilos(plan.lossGrams)} (${(plan.lossBp / 100).toFixed(2)}%).`,
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
    data: { locationId: string; input: P; inputQty: number; inputGrams: number; kargadorId: string | null; note: string | null; openSack: boolean },
    startSignatures: SignatureInput[] | undefined, requireStartSignature: boolean,
  ) {
    const docNumber = await nextDocNumber(tx, storeId, "RSK");
    const job = await tx.resackJob.create({
      data: {
        storeId, docNumber, locationId: data.locationId, inputProductId: data.input.id, inputQty: data.inputQty, inputGrams: data.inputGrams,
        inputValueMinor: valueOf(data.input, data.inputQty), kargadorId: data.kargadorId, note: data.note, openSack: data.openSack, startedById: actor.userId,
      },
      select: { id: true, docNumber: true, locationId: true, inputProductId: true, inputQty: true, inputGrams: true, kargadorId: true },
    });
    if (requireStartSignature) {
      await captureSignatures(tx, storeId, actor, { documentType: "RESACK", documentId: job.id, step: "START", locationId: data.locationId }, startSignatures);
      await requireSignatures(tx, storeId, { documentType: "RESACK", documentId: job.id, step: "START" }, { kargador: !!data.kargadorId });
    }
    const level = await tx.stockLevel.findFirst({ where: { storeId, productId: data.input.id, warehouseId: data.locationId }, select: { id: true } });
    if (!level && !(await bufferIdOf(tx, storeId))) throw new StepError(conflict(`No ${data.input.name} is recorded at this location`));
    await coverShortage(tx, storeId, { productId: data.input.id, warehouseId: data.locationId, needed: data.inputQty, actorId: actor.userId, documentType: "RESACK", documentId: job.id, reason: `resack ${docNumber}` });
    await releaseForTrip(tx, this.leg(storeId, data.input.id, data.locationId, actor, job.id, docNumber), 0, data.inputQty, "RESACK_OUT");
    await tx.auditLog.create({
      data: { storeId, actorType: "USER", actorId: actor.userId, action: "resack.start", entityType: "ResackJob", entityId: job.id, after: { inputQty: data.inputQty, inputGrams: data.inputGrams } },
    });
    return job;
  }

  // ─────────────────────────── public steps ───────────────────────────

  /** One step: start + finish together (the usual case). Also used by Buksan ang sako. */
  async resack(
    storeId: string, actor: Actor,
    input: { locationId?: string; inputProductId?: string; inputQty?: unknown; outputs?: OutputInput[]; kargadorId?: string; note?: string; openSack?: boolean; signatures?: SignatureInput[] },
  ) {
    return this.run(async () => {
      const loc = await this.location(storeId, actor, input.locationId);
      const kargador = await this.kargador(storeId, input.kargadorId);
      if (!kargador) throw new ResackError("Choose the porter (kargador) who did the resack — only the porter signs");
      const qty = input.inputQty;
      if (typeof qty !== "number") throw new ResackError("Enter how many go in");
      const byId = await this.products(storeId, [input.inputProductId ?? "", ...(input.outputs ?? []).map((o) => o.productId ?? "")]);
      const inP = byId.get(input.inputProductId ?? "");
      if (!inP || !inP.isActive) throw new ResackError("Unknown input product");
      const { outs, plan, inputGrams } = this.plan(inP, qty, input.outputs ?? [], byId);
      if (input.openSack && (outs.length !== 1 || outs[0]!.product.stockBaseQuantity !== 1)) {
        throw new ResackError("Open a sack: only one loose (per kilo) product can come out");
      }
      let out = { id: "", docNumber: "", approvalId: null as string | null };
      await prisma.$transaction(async (tx) => {
        const job = await this.writeStart(tx, storeId, actor, { locationId: loc.id, input: inP, inputQty: qty, inputGrams, kargadorId: kargador?.id ?? null, note: input.note?.trim() || null, openSack: !!input.openSack }, undefined, false);
        const approvalId = await this.writeFinish(tx, storeId, actor, job, inP, loc.name, outs, plan, input.signatures);
        out = { id: job.id, docNumber: job.docNumber, approvalId };
      }, txOptions());
      return { ...out, status: "FINISHED", gramsIn: plan.gramsIn, gramsOut: plan.gramsOut, lossGrams: plan.lossGrams, lossBp: plan.lossBp, needsApproval: plan.needsApproval, varietyChange: plan.varietyChange };
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
      },
    });
    return rows.map((j) => ({
      id: j.id, docNumber: j.docNumber, status: j.status, location: j.location, input: j.inputProduct, inputQty: j.inputQty,
      inputGrams: j.inputGrams, outputGrams: j.outputGrams, lossGrams: j.lossGrams, lossBp: j.lossBp, varietyChange: j.varietyChange,
      openSack: j.openSack, kargador: j.kargador, approvalId: j.approvalId, startedAt: j.startedAt, finishedAt: j.finishedAt,
      outputs: j.outputs.map((o) => ({ product: o.product, quantity: o.quantity, grams: o.grams, valueMinor: o.valueMinor })),
    }));
  }
}
