// Rice Ops M2 — shape-checks signatures sent in a request body (untrusted input).
import { HttpException, HttpStatus } from "@nestjs/common";
import type { SignatureInput } from "./people.service.js";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function badRequest(message: string): never {
  throw new HttpException({ type: "validation", errors: [message] }, HttpStatus.UNPROCESSABLE_ENTITY);
}

export function signaturesFrom(v: unknown): SignatureInput[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) badRequest("signatures must be a list");
  return v.map((s) => {
    if (!s || typeof s !== "object") badRequest("invalid signature");
    const o = s as Record<string, unknown>;
    return { signerKind: str(o.signerKind) ?? "", kargadorId: str(o.kargadorId), signerName: str(o.signerName), imagePng: str(o.imagePng) ?? "" };
  });
}

