// Rice Ops M2 — people, kargadors, signatures, approvals ("Para sa iyo"), document
// numbers and drafts ("Tapusin"). Every query is scoped by storeId; every stock step
// in later modules calls requireSignatures() inside its own transaction.

import bcrypt from "bcryptjs";
import { Prisma, type SignerKind } from "@prisma/client";
import type { ApiError } from "@sam-store/contracts";
import { prisma } from "../persistence/prisma-repositories.js";
import { bustMemberships } from "../auth/membership-cache.js";
import { bustTokenVersion } from "../auth/token-version.js";
import {
  ALL_LOCATION_ROLES, APPROVAL_KINDS, DEFAULT_APPROVERS, DRAFT_FLOWS, MAX_DRAFT_BYTES, canActAtLocation, canDecide,
  checkPhotoImage, checkSignatureImage, counterKind, formatDocNumber, isDraftStale, missingMessage, missingSigners,
  pinProblem, ruleFor, type ApprovalKind, type DocPrefix, type SignerKindName,
} from "../domain/people.js";
import { toE164 } from "../domain/phone.js";
import { accountBelongsToStore } from "../auth/account-scope.js";

export type PeopleResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
type Tx = Prisma.TransactionClient;

const fail = (type: "validation", msg: string): { ok: false; error: ApiError } => ({ ok: false, error: { type, errors: [msg] } });
const conflict = (message: string): { ok: false; error: ApiError } => ({ ok: false, error: { type: "conflict", message } });
const notFound = (message: string): { ok: false; error: ApiError } => ({ ok: false, error: { type: "not_found", message } });
const forbidden = (message: string): { ok: false; error: ApiError } => ({ ok: false, error: { type: "forbidden", message } });

/** Thrown inside a transaction when a step is missing signatures; services map it to 422. */
export class SignaturesMissingError extends Error {
  constructor(readonly missing: SignerKindName[]) {
    super(missingMessage(missing));
    this.name = "SignaturesMissingError";
  }
}

/** Thrown inside a transaction when a signature input is invalid. */
export class SignatureInputError extends Error {
  constructor(message: string, readonly kind: "validation" | "forbidden" = "validation") {
    super(message);
    this.name = "SignatureInputError";
  }
}

export interface SignatureInput {
  signerKind: string;
  /** KARGADOR only. */
  kargadorId?: string;
  /** CUSTOMER only (staff and kargador names come from their records). */
  signerName?: string;
  imagePng: string;
}

/** The acting person, resolved by the controller from the token + membership. */
export interface Actor {
  userId: string;
  role: string;
  homeLocationId: string | null;
}

// ─────────────────────────────── numbering ───────────────────────────────

/** Next document number for a prefix, e.g. REL-000123. Atomic per store (row upsert-increment). */
export async function nextDocNumber(tx: Tx, storeId: string, prefix: DocPrefix): Promise<string> {
  const row = await tx.storeCounter.upsert({
    where: { storeId_kind: { storeId, kind: counterKind(prefix) } },
    update: { value: { increment: 1 } },
    create: { storeId, kind: counterKind(prefix), value: 1 },
  });
  return formatDocNumber(prefix, row.value);
}

// ─────────────────────────────── actor / location ───────────────────────────────

/** The membership facts that decide where a person may act. */
export async function loadActor(storeId: string, userId: string, role: string): Promise<Actor> {
  if (role === "PLATFORM_ADMIN") return { userId, role, homeLocationId: null };
  const m = await prisma.userStore.findUnique({ where: { userId_storeId: { userId, storeId } }, select: { homeLocationId: true, role: true } });
  return { userId, role: m?.role ?? role, homeLocationId: m?.homeLocationId ?? null };
}

export function locationRefusal(actor: Actor, locationId: string | null | undefined): string | null {
  return canActAtLocation(actor.role, actor.homeLocationId, locationId) ? null : "You are not assigned to this location";
}

async function locationInStore(db: Tx | typeof prisma, storeId: string, locationId: string) {
  return db.warehouse.findFirst({ where: { id: locationId, storeId }, select: { id: true, isActive: true, name: true } });
}

// ─────────────────────────────── signatures ───────────────────────────────

/**
 * Store the signatures for one step of one document. Runs inside the caller's
 * transaction so the stock change and its signatures commit together.
 * Rules: STAFF = the acting person themself (never someone else's name), and only at
 * a location they may act at; KARGADOR = an active kargador of this store;
 * CUSTOMER = a name is required.
 */
export async function captureSignatures(
  tx: Tx,
  storeId: string,
  actor: Actor,
  doc: { documentType: string; documentId: string; step: string; locationId: string | null },
  inputs: SignatureInput[] | undefined,
): Promise<number> {
  if (!ruleFor(doc.documentType, doc.step)) throw new SignatureInputError(`No signing step for ${doc.documentType}:${doc.step}`);
  if (!inputs || inputs.length === 0) return 0;
  if (!Array.isArray(inputs) || inputs.length > 6) throw new SignatureInputError("Up to 6 signatures per step only");
  let n = 0;
  for (const s of inputs) {
    const img = s?.signerKind === "SLIP_PHOTO" ? checkPhotoImage(s?.imagePng) : checkSignatureImage(s?.imagePng);
    if (!img.ok) throw new SignatureInputError(img.error);
    let signerName: string;
    let signerUserId: string | null = null;
    let kargadorId: string | null = null;
    switch (s.signerKind) {
      case "STAFF": {
        const refusal = locationRefusal(actor, doc.locationId);
        if (refusal) throw new SignatureInputError(refusal, "forbidden");
        const u = await tx.user.findUnique({ where: { id: actor.userId }, select: { name: true, phone: true, email: true } });
        signerName = u?.name || u?.phone || u?.email || "Staff";
        signerUserId = actor.userId;
        break;
      }
      case "KARGADOR": {
        const k = s.kargadorId ? await tx.kargador.findFirst({ where: { id: s.kargadorId, storeId, isActive: true }, select: { id: true, name: true } }) : null;
        if (!k) throw new SignatureInputError("Choose a porter from the list");
        signerName = k.name;
        kargadorId = k.id;
        break;
      }
      case "CUSTOMER": {
        const name = s.signerName?.trim() ?? "";
        if (name.length < 2 || name.length > 80) throw new SignatureInputError("Enter the customer's name");
        signerName = name;
        break;
      }
      case "SLIP_PHOTO": {
        signerName = "Papel";
        break;
      }
      default:
        throw new SignatureInputError("Unknown signature type");
    }
    await tx.signature.create({
      data: {
        storeId,
        documentType: doc.documentType,
        documentId: doc.documentId,
        step: doc.step,
        signerKind: s.signerKind as SignerKind,
        signerUserId,
        kargadorId,
        signerName,
        imagePng: s.imagePng,
        imageSha256: img.sha256,
        locationId: doc.locationId,
        capturedById: actor.userId,
      },
    });
    n++;
  }
  return n;
}

/** Throws SignaturesMissingError unless every required signer has signed this step. */
export async function requireSignatures(
  tx: Tx,
  storeId: string,
  doc: { documentType: string; documentId: string; step: string },
  ctx: { kargador?: boolean; customer?: boolean } = {},
): Promise<void> {
  const have = await tx.signature.findMany({
    where: { storeId, documentType: doc.documentType, documentId: doc.documentId, step: doc.step },
    select: { signerKind: true },
  });
  const missing = missingSigners(doc.documentType, doc.step, have, ctx);
  if (missing.length) throw new SignaturesMissingError(missing);
}

/** Map the two signature errors to an API result (null = not a signature error). */
export function signatureErrorResult(e: unknown): { ok: false; error: ApiError } | null {
  if (e instanceof SignaturesMissingError) return fail("validation", e.message);
  if (e instanceof SignatureInputError) return e.kind === "forbidden" ? forbidden(e.message) : fail("validation", e.message);
  return null;
}

// ─────────────────────────────── approvals ───────────────────────────────

export type ApprovalHandler = (tx: Tx, approval: { id: string; storeId: string; kind: string; documentType: string; documentId: string; status: "APPROVED" | "DECLINED"; decidedById: string }) => Promise<void>;
const approvalHandlers = new Map<string, ApprovalHandler>();

/** Later modules (resack, write-off, utang…) register what happens when their approval is decided. */
export function registerApprovalHandler(kind: ApprovalKind, handler: ApprovalHandler): void {
  approvalHandlers.set(kind, handler);
}

/** Open an approval (idempotent: an existing PENDING one for the same document + kind is returned). */
export async function requestApproval(
  tx: Tx,
  input: { storeId: string; kind: ApprovalKind; documentType: string; documentId: string; locationId?: string | null; summary: string; detail?: Prisma.InputJsonValue; requestedById: string; approverRoles?: string[] },
): Promise<{ id: string; created: boolean }> {
  const existing = await tx.approvalRequest.findFirst({
    where: { storeId: input.storeId, kind: input.kind, documentType: input.documentType, documentId: input.documentId, status: "PENDING" },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  const row = await tx.approvalRequest.create({
    data: {
      storeId: input.storeId,
      kind: input.kind,
      documentType: input.documentType,
      documentId: input.documentId,
      locationId: input.locationId ?? null,
      summary: input.summary.slice(0, 300),
      detail: input.detail,
      approverRoles: input.approverRoles ?? DEFAULT_APPROVERS[input.kind],
      requestedById: input.requestedById,
    },
    select: { id: true },
  });
  return { id: row.id, created: true };
}

// ─────────────────────────────── service ───────────────────────────────

export class PeopleService {
  // ── members: home location + PIN ──

  async listMembers(storeId: string) {
    const rows = await prisma.userStore.findMany({
      where: { storeId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: {
        role: true,
        homeLocationId: true,
        user: { select: { id: true, name: true, phone: true, email: true, pinHash: true, pinLockedUntil: true } },
      },
    });
    const now = Date.now();
    return rows.map((r) => ({
      userId: r.user.id,
      name: r.user.name,
      phone: r.user.phone,
      email: r.user.email,
      role: r.role,
      homeLocationId: r.homeLocationId,
      hasPin: !!r.user.pinHash,
      pinLocked: !!r.user.pinLockedUntil && r.user.pinLockedUntil.getTime() > now,
    }));
  }

  /** Owner sets a member's home location and/or PIN. A new PIN signs that person out everywhere. */
  async updateMember(
    storeId: string,
    userId: string,
    input: { homeLocationId?: string | null; pin?: string; unlock?: boolean },
    actorId: string,
  ): Promise<PeopleResult<{ userId: string; homeLocationId: string | null; hasPin: boolean }>> {
    const m = await prisma.userStore.findUnique({ where: { userId_storeId: { userId, storeId } }, select: { homeLocationId: true, status: true } });
    if (!m || m.status !== "ACTIVE") return notFound("That person is not in this store");
    const data: Prisma.UserStoreUpdateInput = {};
    if (input.homeLocationId !== undefined) {
      if (input.homeLocationId === null || input.homeLocationId === "") data.homeLocation = { disconnect: true };
      else {
        const loc = await locationInStore(prisma, storeId, input.homeLocationId);
        if (!loc) return fail("validation", "Unknown location");
        if (!loc.isActive) return fail("validation", "That location is closed");
        data.homeLocation = { connect: { id: loc.id } };
      }
    }
    let pinHash: string | undefined;
    if (input.pin !== undefined) {
      const problem = pinProblem(input.pin);
      if (problem) return fail("validation", problem);
      // M11: a PIN opens the whole account — only set it for someone who works at this store alone.
      if (!(await accountBelongsToStore(prisma, userId, storeId))) {
        return forbidden("This person also works in another store — they must change their own PIN.");
      }
      pinHash = await bcrypt.hash(input.pin, 10);
    }
    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length) await tx.userStore.update({ where: { userId_storeId: { userId, storeId } }, data });
      if (pinHash || input.unlock) {
        await tx.user.update({
          where: { id: userId },
          data: {
            ...(pinHash ? { pinHash, tokenVersion: { increment: 1 } } : {}),
            pinFailedCount: 0,
            pinLockedUntil: null,
          },
        });
      }
      await tx.auditLog.create({
        data: {
          storeId, actorType: "USER", actorId, action: "member.people.update", entityType: "User", entityId: userId,
          before: { homeLocationId: m.homeLocationId },
          after: { homeLocationId: input.homeLocationId === undefined ? m.homeLocationId : input.homeLocationId || null, pinChanged: !!pinHash, unlocked: !!input.unlock },
        },
      });
    });
    if (pinHash) await bustTokenVersion(userId);
    await bustMemberships();
    const after = await prisma.userStore.findUnique({ where: { userId_storeId: { userId, storeId } }, select: { homeLocationId: true, user: { select: { pinHash: true } } } });
    return { ok: true, value: { userId, homeLocationId: after?.homeLocationId ?? null, hasPin: !!after?.user.pinHash } };
  }

  /** A person changes their own PIN by proving the current PIN (or password if no PIN yet). */
  async changeOwnPin(userId: string, current: string, newPin: string): Promise<PeopleResult<{ ok: true }>> {
    const problem = pinProblem(newPin);
    if (problem) return fail("validation", problem);
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { pinHash: true, passwordHash: true } });
    if (!u) return notFound("User not found");
    const valid = await bcrypt.compare(current ?? "", u.pinHash ?? u.passwordHash);
    if (!valid) return forbidden(u.pinHash ? "The current PIN is wrong" : "The password is wrong");
    await prisma.user.update({ where: { id: userId }, data: { pinHash: await bcrypt.hash(newPin, 10), pinFailedCount: 0, pinLockedUntil: null } });
    return { ok: true, value: { ok: true } };
  }

  // ── kargadors ──

  async listKargadors(storeId: string, includeInactive = false) {
    return prisma.kargador.findMany({
      where: { storeId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      select: { id: true, name: true, phone: true, photoUrl: true, homeLocationId: true, isActive: true, createdAt: true },
    });
  }

  async saveKargador(
    storeId: string,
    id: string | null,
    input: { name?: string; phone?: string | null; photoUrl?: string | null; homeLocationId?: string | null; isActive?: boolean },
    actorId: string,
  ): Promise<PeopleResult<{ id: string }>> {
    const errors: string[] = [];
    const data: Prisma.KargadorUncheckedUpdateInput = {};
    if (id === null || input.name !== undefined) {
      const name = input.name?.trim().replace(/\s+/g, " ") ?? "";
      if (name.length < 2 || name.length > 60) errors.push("Name: 2–60 letters");
      data.name = name;
    }
    if (input.phone !== undefined) {
      if (input.phone === null || input.phone === "") data.phone = null;
      else {
        const e164 = toE164(input.phone);
        if (!e164) errors.push("The phone number is wrong");
        data.phone = e164 ?? null;
      }
    }
    if (input.photoUrl !== undefined) {
      if (input.photoUrl && !/^https:\/\/\S{1,500}$/.test(input.photoUrl)) errors.push("The photo must be an https link");
      data.photoUrl = input.photoUrl || null;
    }
    if (input.homeLocationId !== undefined) {
      if (input.homeLocationId) {
        const loc = await locationInStore(prisma, storeId, input.homeLocationId);
        if (!loc) errors.push("Unknown location");
      }
      data.homeLocationId = input.homeLocationId || null;
    }
    if (input.isActive !== undefined) data.isActive = !!input.isActive;
    if (errors.length) return { ok: false, error: { type: "validation", errors } };
    try {
      if (id === null) {
        const row = await prisma.kargador.create({ data: { ...(data as Prisma.KargadorUncheckedCreateInput), storeId }, select: { id: true } });
        await prisma.auditLog.create({ data: { storeId, actorType: "USER", actorId, action: "kargador.create", entityType: "Kargador", entityId: row.id, after: { name: data.name } as unknown as Prisma.InputJsonValue } });
        return { ok: true, value: { id: row.id } };
      }
      const updated = await prisma.kargador.updateMany({ where: { id, storeId }, data });
      if (updated.count === 0) return notFound("Porter not found");
      await prisma.auditLog.create({ data: { storeId, actorType: "USER", actorId, action: "kargador.update", entityType: "Kargador", entityId: id, after: data as unknown as Prisma.InputJsonValue } });
      return { ok: true, value: { id } };
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return conflict("A porter with that name already exists");
      throw e;
    }
  }

  // ── signatures (standalone capture, for steps finished on another phone) ──

  async addSignatures(
    storeId: string,
    actor: Actor,
    doc: { documentType: string; documentId: string; step: string; locationId: string | null },
    inputs: SignatureInput[],
  ): Promise<PeopleResult<{ saved: number }>> {
    if (!inputs?.length) return fail("validation", "No signature");
    if (doc.locationId && !(await locationInStore(prisma, storeId, doc.locationId))) return fail("validation", "Unknown location");
    try {
      const saved = await prisma.$transaction((tx) => captureSignatures(tx, storeId, actor, doc, inputs));
      return { ok: true, value: { saved } };
    } catch (e) {
      const r = signatureErrorResult(e);
      if (r) return r;
      throw e;
    }
  }

  /** The signature trail of a document, oldest first. Images included (they are the evidence). */
  async listSignatures(storeId: string, documentType: string, documentId: string) {
    return prisma.signature.findMany({
      where: { storeId, documentType, documentId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, step: true, signerKind: true, signerName: true, signerUserId: true, kargadorId: true,
        imagePng: true, imageSha256: true, locationId: true, capturedById: true, createdAt: true,
      },
    });
  }

  // ── approvals ──

  async listApprovals(storeId: string, status: string = "PENDING", role?: string) {
    const rows = await prisma.approvalRequest.findMany({
      where: { storeId, ...(status === "ALL" ? {} : { status: status as "PENDING" }) },
      orderBy: { createdAt: status === "PENDING" ? "asc" : "desc" },
      take: 200,
      include: { location: { select: { code: true, name: true } } },
    });
    return rows.map((r) => ({
      id: r.id, kind: r.kind, documentType: r.documentType, documentId: r.documentId, summary: r.summary, detail: r.detail,
      location: r.location, status: r.status, requestedById: r.requestedById, decidedById: r.decidedById, decidedAt: r.decidedAt,
      decisionNote: r.decisionNote, createdAt: r.createdAt, approverRoles: r.approverRoles,
      canDecide: role ? r.approverRoles.includes(role) : undefined,
    }));
  }

  async countPending(storeId: string, role: string) {
    return prisma.approvalRequest.count({ where: { storeId, status: "PENDING", approverRoles: { has: role } } });
  }

  /** Decide with the decider's own PIN — the phone may be in someone else's hand. */
  async decideApproval(
    storeId: string,
    id: string,
    actor: Actor,
    input: { decision?: string; note?: string; pin?: string },
  ): Promise<PeopleResult<{ id: string; status: string }>> {
    const decision = input.decision === "APPROVE" ? "APPROVED" : input.decision === "DECLINE" ? "DECLINED" : null;
    if (!decision) return fail("validation", "decision must be APPROVE or DECLINE");
    const note = input.note?.trim() ?? "";
    if (decision === "DECLINED" && note.length < 3) return fail("validation", "Enter the reason for declining");
    const approval = await prisma.approvalRequest.findFirst({ where: { id, storeId } });
    if (!approval) return notFound("Approval not found");
    const may = canDecide(actor.role, approval.approverRoles, approval.requestedById === actor.userId);
    if (!may.ok) return forbidden(may.reason);

    const u = await prisma.user.findUnique({ where: { id: actor.userId }, select: { pinHash: true } });
    if (!u?.pinHash) return fail("validation", "Set a PIN first before deciding");
    if (!(await bcrypt.compare(input.pin ?? "", u.pinHash))) return forbidden("Wrong PIN");

    try {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.approvalRequest.updateMany({
          where: { id, storeId, status: "PENDING" },
          data: { status: decision, decidedById: actor.userId, decidedAt: new Date(), decisionNote: note || null },
        });
        if (claimed.count === 0) throw new DecidedAlready();
        const handler = approvalHandlers.get(approval.kind);
        if (handler) {
          await handler(tx, { id, storeId, kind: approval.kind, documentType: approval.documentType, documentId: approval.documentId, status: decision, decidedById: actor.userId });
        }
        await tx.auditLog.create({
          data: { storeId, actorType: "USER", actorId: actor.userId, action: `approval.${decision.toLowerCase()}`, entityType: "ApprovalRequest", entityId: id, after: { kind: approval.kind, documentType: approval.documentType, documentId: approval.documentId, note: note || null } },
        });
      });
    } catch (e) {
      if (e instanceof DecidedAlready) return conflict("This was already decided");
      throw e;
    }
    return { ok: true, value: { id, status: decision } };
  }

  // ── drafts ("Tapusin") ──

  async listDrafts(storeId: string, actor: Actor) {
    const rows = await prisma.flowDraft.findMany({
      where: {
        storeId,
        status: "OPEN",
        // Staff with a home location see their location's drafts (and location-less ones they started).
        ...(actor.homeLocationId && !(ALL_LOCATION_ROLES as readonly string[]).includes(actor.role)
          ? { OR: [{ locationId: actor.homeLocationId }, { locationId: null, createdById: actor.userId }] }
          : {}),
      },
      orderBy: { updatedAt: "asc" },
      take: 100,
      include: { location: { select: { code: true, name: true } } },
    });
    const now = new Date();
    return rows.map((d) => ({
      id: d.id, flow: d.flow, location: d.location, locationId: d.locationId, docNumber: d.docNumber, step: d.step, data: d.data,
      version: d.version, createdById: d.createdById, updatedById: d.updatedById, createdAt: d.createdAt, updatedAt: d.updatedAt,
      stale: isDraftStale(d.updatedAt, now),
    }));
  }

  async saveDraft(
    storeId: string,
    actor: Actor,
    id: string | null,
    input: { flow?: string; locationId?: string | null; step?: number; data?: unknown; version?: number },
  ): Promise<PeopleResult<{ id: string; version: number }>> {
    const json = JSON.stringify(input.data ?? {});
    if (json.length > MAX_DRAFT_BYTES) return fail("validation", "The draft is too big");
    const step = input.step ?? 1;
    if (!Number.isInteger(step) || step < 1 || step > 20) return fail("validation", "step must be 1–20");
    if (id === null) {
      if (!(DRAFT_FLOWS as readonly string[]).includes(input.flow ?? "")) return fail("validation", "Unknown flow");
      const locationId = input.locationId || null;
      if (locationId && !(await locationInStore(prisma, storeId, locationId))) return fail("validation", "Unknown location");
      const refusal = locationId ? locationRefusal(actor, locationId) : null;
      if (refusal) return forbidden(refusal);
      const row = await prisma.flowDraft.create({
        data: { storeId, flow: input.flow!, locationId, step, data: JSON.parse(json), createdById: actor.userId, updatedById: actor.userId },
        select: { id: true, version: true },
      });
      return { ok: true, value: row };
    }
    const existing = await prisma.flowDraft.findFirst({ where: { id, storeId }, select: { locationId: true, status: true } });
    if (!existing) return notFound("Draft not found");
    const refusal = locationRefusal(actor, existing.locationId);
    if (existing.locationId && refusal) return forbidden(refusal);
    if (!Number.isInteger(input.version)) return fail("validation", "version is required");
    const updated = await prisma.flowDraft.updateMany({
      where: { id, storeId, status: "OPEN", version: input.version },
      data: { step, data: JSON.parse(json), updatedById: actor.userId, version: { increment: 1 } },
    });
    if (updated.count === 0) return conflict(existing.status !== "OPEN" ? "This draft is already finished or cancelled" : "Someone else edited this. Open it again.");
    return { ok: true, value: { id, version: input.version! + 1 } };
  }

  async closeDraft(storeId: string, actor: Actor, id: string, status: string): Promise<PeopleResult<{ id: string; status: string }>> {
    if (status !== "DONE" && status !== "CANCELLED") return fail("validation", "status must be DONE or CANCELLED");
    const existing = await prisma.flowDraft.findFirst({ where: { id, storeId }, select: { locationId: true } });
    if (!existing) return notFound("Draft not found");
    if (existing.locationId) {
      const refusal = locationRefusal(actor, existing.locationId);
      if (refusal) return forbidden(refusal);
    }
    const r = await prisma.flowDraft.updateMany({ where: { id, storeId, status: "OPEN" }, data: { status, updatedById: actor.userId } });
    if (r.count === 0) return conflict("This draft is already closed");
    return { ok: true, value: { id, status } };
  }
}

class DecidedAlready extends Error {}

export const APPROVAL_KIND_LIST = APPROVAL_KINDS;
