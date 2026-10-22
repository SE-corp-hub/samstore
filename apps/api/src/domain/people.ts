// Rice Ops M2 — pure rules for people, signatures, approvals, numbering and drafts.
// No DB here: services call these so the rules are tested once, in one place.

import { createHash } from "node:crypto";

// ─────────────────────────────── PIN ───────────────────────────────

export const PIN_MAX_FAILS = 5;
export const PIN_LOCK_MINUTES = 15;

/** A PIN is exactly 4 digits and not trivially guessable (1111, 1234, 4321). */
export function pinProblem(pin: unknown): string | null {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) return "The PIN must be 4 numbers";
  if (/^(\d)\1{3}$/.test(pin)) return "Do not use the same number 4 times (e.g. 1111)";
  const d = [...pin].map(Number);
  const up = d.every((v, i) => i === 0 || v === d[i - 1]! + 1);
  const down = d.every((v, i) => i === 0 || v === d[i - 1]! - 1);
  if (up || down) return "Do not use numbers in a row (e.g. 1234)";
  return null;
}

/** Seconds left on a PIN lock (0 = not locked). */
export function pinLockSecondsLeft(lockedUntil: Date | null | undefined, now: Date): number {
  if (!lockedUntil) return 0;
  return Math.max(0, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}

// ─────────────────────────────── Locations ───────────────────────────────

/** Roles that work across every location regardless of their home location. */
export const ALL_LOCATION_ROLES = ["OWNER", "MANAGER", "PLATFORM_ADMIN"] as const;

/**
 * May this person act (release, receive, count, sign as staff) at `locationId`?
 * Owner/manager: everywhere. Others: their home location, or everywhere when they
 * have no home location set.
 */
export function canActAtLocation(role: string, homeLocationId: string | null | undefined, locationId: string | null | undefined): boolean {
  if ((ALL_LOCATION_ROLES as readonly string[]).includes(role)) return true;
  if (!homeLocationId) return true;
  return !!locationId && homeLocationId === locationId;
}

// ─────────────────────────────── Signatures ───────────────────────────────

export type SignerKindName = "STAFF" | "KARGADOR" | "CUSTOMER" | "SLIP_PHOTO";

export interface StepRule {
  /** Always required. */
  always: SignerKindName[];
  /** Required when a kargador carried or worked on it. */
  withKargador?: SignerKindName[];
  /** Required when the step involves a customer (utang, delivery slip). */
  withCustomer?: SignerKindName[];
}

/**
 * Who must sign which step. Keyed "DOCUMENT_TYPE:STEP". A step with no rule here
 * cannot be signed-off at all (fail closed: an unknown step is refused).
 */
export const SIGNATURE_RULES: Record<string, StepRule> = {
  "TRANSFER:RELEASE": { always: ["STAFF"], withKargador: ["KARGADOR"] },
  "TRANSFER:RECEIVE": { always: ["STAFF"], withKargador: ["KARGADOR"] },
  "RELEASE:RELEASE": { always: ["STAFF", "KARGADOR"] },
  "RELEASE:DELIVERED": { always: ["STAFF", "KARGADOR"], withCustomer: ["CUSTOMER"] },
  "RELEASE:RETURN": { always: ["STAFF", "KARGADOR"] },
  "RETURN:RECEIVE": { always: ["STAFF"], withKargador: ["KARGADOR"] },
  // Only the porter (kargador) signs a resack — he is the one who did it and weighed it.
  "RESACK:START": { always: ["KARGADOR"] },
  "RESACK:FINISH": { always: ["KARGADOR"] },
  "SALE:UTANG": { always: ["CUSTOMER"] },
  "UTANG:PAYMENT": { always: ["STAFF"], withCustomer: ["CUSTOMER"] },
  "COUNT:SUBMIT": { always: ["STAFF"] },
  "COUNT:QUICK": { always: ["STAFF"] },
  "WRITE_OFF:CREATE": { always: ["STAFF"] },
  "STOCK_IN:RECEIVE": { always: ["STAFF"] },
  "PAPER_SLIP:ENCODE": { always: ["STAFF", "SLIP_PHOTO"] },
  "CLOSE:DAY": { always: ["STAFF"] },
};

export const SIGNABLE_DOCUMENT_TYPES = [...new Set(Object.keys(SIGNATURE_RULES).map((k) => k.split(":")[0]))];

export function ruleFor(documentType: string, step: string): StepRule | null {
  return SIGNATURE_RULES[`${documentType}:${step}`] ?? null;
}

/** The signer kinds a step needs, given who took part. */
export function requiredSigners(documentType: string, step: string, ctx: { kargador?: boolean; customer?: boolean } = {}): SignerKindName[] | null {
  const rule = ruleFor(documentType, step);
  if (!rule) return null;
  return [
    ...rule.always,
    ...(ctx.kargador ? rule.withKargador ?? [] : []),
    ...(ctx.customer ? rule.withCustomer ?? [] : []),
  ];
}

/** Which required signer kinds are not covered by the signatures given. Unknown step → everything is missing. */
export function missingSigners(
  documentType: string,
  step: string,
  have: { signerKind: string }[],
  ctx: { kargador?: boolean; customer?: boolean } = {},
): SignerKindName[] {
  const need = requiredSigners(documentType, step, ctx);
  if (!need) return ["STAFF"];
  const got = new Set(have.map((h) => h.signerKind));
  return need.filter((k) => !got.has(k));
}

const SIGNER_LABEL: Record<SignerKindName, string> = {
  STAFF: "staff",
  KARGADOR: "porter",
  CUSTOMER: "customer",
  SLIP_PHOTO: "photo of the paper slip",
};

export function missingMessage(missing: SignerKindName[]): string {
  return `Missing signature: ${missing.map((m) => SIGNER_LABEL[m]).join(", ")}`;
}

export const MAX_SIGNATURE_BYTES = 150_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PREFIX = "data:image/png;base64,";

/** Validates a finger-drawn PNG data URL. Returns its sha256 or an error message. */
export function checkSignatureImage(dataUrl: unknown): { ok: true; sha256: string } | { ok: false; error: string } {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PREFIX)) return { ok: false, error: "The signature must be a PNG image" };
  const b64 = dataUrl.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, error: "The signature image is broken" };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > MAX_SIGNATURE_BYTES) return { ok: false, error: "The signature image is too big" };
  if (bytes.length < 67 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, error: "The signature image is broken" };
  return { ok: true, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Rice Ops M5: a photo of a paper slip (or a delivery slip) — a JPEG from the phone camera, or a PNG. */
export const MAX_PHOTO_BYTES = 400_000;
const JPEG_PREFIX = "data:image/jpeg;base64,";
export function checkPhotoImage(dataUrl: unknown): { ok: true; sha256: string } | { ok: false; error: string } {
  if (typeof dataUrl !== "string" || !(dataUrl.startsWith(JPEG_PREFIX) || dataUrl.startsWith(PREFIX))) return { ok: false, error: "The photo must be a JPEG or PNG" };
  const isJpeg = dataUrl.startsWith(JPEG_PREFIX);
  const b64 = dataUrl.slice(isJpeg ? JPEG_PREFIX.length : PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, error: "The photo is broken" };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, error: "The photo is too big — take it again" };
  const magicOk = isJpeg ? bytes.length > 100 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff : bytes.length >= 67 && bytes.subarray(0, 8).equals(PNG_MAGIC);
  if (!magicOk) return { ok: false, error: "The photo is broken" };
  return { ok: true, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// ─────────────────────────────── Numbering ───────────────────────────────

/** Document number prefixes, one counter each (StoreCounter kind "DOC_<prefix>"). */
export const DOC_PREFIXES = ["REL", "TR", "RSK", "CNT", "WO", "RET", "IN", "SLP", "SP", "PO", "SPY"] as const;
export type DocPrefix = (typeof DOC_PREFIXES)[number];

export function formatDocNumber(prefix: DocPrefix, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("document counter must be a positive integer");
  return `${prefix}-${String(n).padStart(6, "0")}`;
}

export function counterKind(prefix: DocPrefix): string {
  return `DOC_${prefix}`;
}

// ─────────────────────────────── Approvals ───────────────────────────────

export const APPROVAL_KINDS = ["LOSS_OVER_TOLERANCE", "UTANG_OVER_LIMIT", "MANUAL_ITEM", "WRITE_OFF", "VOID", "TRANSFER", "STOCK_OVERRIDE", "TRANSIT_SHORT", "REFUND", "COUNT"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Default deciders per kind. Losses are the store owner's call (operator decision). */
export const DEFAULT_APPROVERS: Record<ApprovalKind, string[]> = {
  LOSS_OVER_TOLERANCE: ["OWNER"],
  UTANG_OVER_LIMIT: ["OWNER"],
  MANUAL_ITEM: ["OWNER", "MANAGER"],
  WRITE_OFF: ["OWNER"],
  VOID: ["OWNER", "MANAGER"],
  TRANSFER: ["OWNER", "MANAGER"],
  STOCK_OVERRIDE: ["OWNER", "MANAGER"],
  TRANSIT_SHORT: ["OWNER"], // M3: rice lost on a trip (Kulang sa lipat)
  REFUND: ["OWNER", "MANAGER"], // M3: refused delivery / returned rice — settle the money
  COUNT: ["OWNER"], // M8: a full count's adjustments post when the owner approves
};

/** May `role` decide an approval that lists `approverRoles`? Platform admin never decides store business. */
export function canDecide(role: string, approverRoles: readonly string[], isRequester: boolean): { ok: true } | { ok: false; reason: string } {
  if (!approverRoles.includes(role)) return { ok: false, reason: "Only the owner can decide this" };
  // A manager cannot approve their own request; the owner can (they are the last word).
  if (isRequester && role !== "OWNER") return { ok: false, reason: "You cannot approve your own request" };
  return { ok: true };
}

// ─────────────────────────────── Drafts ───────────────────────────────

export const DRAFT_FLOWS = ["SALE", "RELEASE", "RECEIVE", "TRANSFER", "RESACK", "COUNT", "WRITE_OFF", "STOCK_IN", "RETURN", "PAPER_SLIP", "CLOSE"] as const;
export const DRAFT_STALE_MS = 2 * 60 * 60 * 1000;
export const MAX_DRAFT_BYTES = 32_000;

export function isDraftStale(updatedAt: Date, now: Date): boolean {
  return now.getTime() - updatedAt.getTime() > DRAFT_STALE_MS;
}
