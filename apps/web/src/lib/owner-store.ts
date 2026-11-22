// The store the owner last sold at on this tablet (2026-11-22, owner's 4-step flow: Customer · Items · Check · Pay).
// POS and Pre-order start with this store already chosen, shown as a small "Selling at" line with Change, so the
// only question before the rice is the customer. Per tablet (localStorage), shared by POS and Pre-order.

const KEY = "sam.ownerStore";

export function rememberedStore(): string | null {
  try { return localStorage.getItem(KEY) || null; } catch { return null; }
}

export function rememberStore(id: string | null | undefined): void {
  try { if (id) localStorage.setItem(KEY, id); } catch { /* private window: asked again next time */ }
}
