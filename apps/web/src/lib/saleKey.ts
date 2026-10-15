// Rice Ops M5 — one idempotency key per sale. Kept until the sale succeeds, so a
// double-tap or a retry after a dropped signal returns the same sale.
export function newSaleKey(): string {
  const c = typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (c && typeof c.randomUUID === "function") return `sale-${c.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `sale-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
