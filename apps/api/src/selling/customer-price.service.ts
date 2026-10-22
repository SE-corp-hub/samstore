// Special prices: a loyal customer's own price for a product (per piece; per kilo for loose rice).
// At sale time this beats the location price and the product price. Owner/manager set them; staff only see them at the counter.

import type { ApiError } from "@sam-store/contracts";
import { prisma } from "../persistence/prisma-repositories.js";
import { isLooseP } from "../domain/counting.js";

export type CustomerPriceResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
const invalid = (m: string) => ({ ok: false as const, error: { type: "validation" as const, errors: [m] } });
const notFound = (m: string) => ({ ok: false as const, error: { type: "not_found" as const, message: m } });

export class CustomerPriceService {
  async list(storeId: string, storeCustomerId: string | undefined): Promise<CustomerPriceResult<{ prices: { id: string; productId: string; name: string; loose: boolean; priceMinor: number; listPriceMinor: number }[] }>> {
    if (!storeCustomerId) return invalid("Choose a customer");
    const rows = await prisma.customerPrice.findMany({ where: { storeId, storeCustomerId }, orderBy: { createdAt: "asc" } });
    const prods = new Map((await prisma.product.findMany({ where: { storeId, id: { in: rows.map((r) => r.productId) } }, select: { id: true, name: true, priceMinor: true, stockBaseUnit: true, stockBaseQuantity: true } })).map((p) => [p.id, p]));
    return {
      ok: true,
      value: { prices: rows.flatMap((r) => { const p = prods.get(r.productId); return p ? [{ id: r.id, productId: r.productId, name: p.name, loose: isLooseP(p), priceMinor: r.priceMinor, listPriceMinor: p.priceMinor }] : []; }) },
    };
  }

  async set(storeId: string, actorId: string, input: { customerId?: string; productId?: string; priceMinor?: unknown }): Promise<CustomerPriceResult<{ id: string }>> {
    const price = input.priceMinor;
    if (typeof price !== "number" || !Number.isInteger(price) || price < 1 || price > 100_000_000) return invalid("Enter the special price");
    const sc = input.customerId ? await prisma.storeCustomer.findFirst({ where: { id: input.customerId, storeId }, select: { id: true } }) : null;
    if (!sc) return notFound("Customer not found");
    const product = input.productId ? await prisma.product.findFirst({ where: { id: input.productId, storeId }, select: { id: true, name: true, priceMinor: true } }) : null;
    if (!product) return notFound("Product not found");
    const row = await prisma.customerPrice.upsert({
      where: { storeId_storeCustomerId_productId: { storeId, storeCustomerId: sc.id, productId: product.id } },
      create: { storeId, storeCustomerId: sc.id, productId: product.id, priceMinor: price, createdById: actorId },
      update: { priceMinor: price },
      select: { id: true },
    });
    await prisma.auditLog.create({ data: { storeId, actorType: "USER", actorId, action: "customer_price.set", entityType: "CustomerPrice", entityId: row.id, after: { storeCustomerId: sc.id, productId: product.id, priceMinor: price, listPriceMinor: product.priceMinor } } });
    return { ok: true, value: { id: row.id } };
  }

  async remove(storeId: string, actorId: string, id: string): Promise<CustomerPriceResult<{ id: string }>> {
    const row = await prisma.customerPrice.findFirst({ where: { id, storeId } });
    if (!row) return notFound("Special price not found");
    await prisma.customerPrice.delete({ where: { id } });
    await prisma.auditLog.create({ data: { storeId, actorType: "USER", actorId, action: "customer_price.remove", entityType: "CustomerPrice", entityId: id, after: { storeCustomerId: row.storeCustomerId, productId: row.productId, priceMinor: row.priceMinor } } });
    return { ok: true, value: { id } };
  }
}
