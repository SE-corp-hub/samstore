// Purchases (read only since 2026-11-21).
// - Purchase + PurchaseItem keep the old supplier/cost records; the list still reads them.
// - Recording a NEW purchase is closed: it added stock to the main store only, with no signature, beside
//   Stock in, so one delivery could be counted twice and it could never say which store got the rice.
//   Rice arrives through Stock in (it names the store); what is owed is on Supplier orders.

import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type PurchaseResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const PURCHASES_SERVICE = Symbol("PURCHASES_SERVICE");

export const PURCHASES_CLOSED = "Purchases is closed. Receive rice with Stock in (it asks which store), and record what is owed on Supplier orders.";

export class PurchasesService {
  /** Closed: see the note at the top. Old copies of the app get a plain answer instead of a stock change. */
  async create(_storeId: string, _actorId: string, _input: unknown): Promise<PurchaseResult<never>> {
    return { ok: false, error: { type: "conflict", message: PURCHASES_CLOSED } };
  }

  async list(storeId: string) {
    return prisma.purchase.findMany({
      where: { storeId },
      orderBy: { purchasedAt: "desc" },
      take: 100,
      include: { items: { include: { product: { select: { name: true, sku: true } } } }, supplier: { select: { name: true } } },
    });
  }
}
