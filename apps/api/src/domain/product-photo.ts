// Product pictures: the tablet shrinks the photo (about 480 px, JPEG) before it is sent, so a
// picture is a few dozen kilobytes. The server still checks the type and the size itself.

import { randomBytes } from "node:crypto";

/** Bigger than any shrunk tablet photo; stops a full-size camera picture by mistake. */
export const PHOTO_MAX_BYTES = 400_000;
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

/** The first bytes each allowed type starts with, so a renamed file is refused. */
function looksLike(mime: PhotoType, b: Buffer): boolean {
  if (mime === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/png") return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
}

/** A "data:image/jpeg;base64,…" picture → its type and bytes, or the reason it is refused. */
export function parsePhoto(dataUrl: unknown): { ok: true; mime: PhotoType; data: Uint8Array<ArrayBuffer> } | { ok: false; error: string } {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) return { ok: false, error: "Choose a picture" };
  if (dataUrl.length > Math.ceil(PHOTO_MAX_BYTES * 1.4) + 64) return { ok: false, error: "The picture is too big — try again (the app makes it smaller)" };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return { ok: false, error: "Use a JPG, PNG or WebP picture" };
  const mime = m[1] as PhotoType;
  const data = Buffer.from(m[2] ?? "", "base64");
  if (data.length === 0 || data.length > PHOTO_MAX_BYTES) return { ok: false, error: "The picture is too big — try again (the app makes it smaller)" };
  if (!looksLike(mime, data)) return { ok: false, error: "That file is not a picture" };
  return { ok: true, mime, data: new Uint8Array(data) };
}

/** A new random key per picture: its address is unguessable and never shows other content. */
export const newPhotoKey = () => randomBytes(18).toString("base64url");

/** Keys are newPhotoKey() output; anything else is refused before the database is asked. */
export const isPhotoKey = (k: unknown): k is string => typeof k === "string" && /^[A-Za-z0-9_-]{16,40}$/.test(k);
