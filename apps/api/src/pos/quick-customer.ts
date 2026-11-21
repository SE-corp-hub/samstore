// A customer added at the counter (POS or Pre-order) with only a name, often no mobile number.
// Find-or-make, so the same name typed twice (or a sale saved offline and sent again) never makes two customers.
import { prisma } from "../persistence/prisma-repositories.js";
import { cacheBust, cacheKey } from "../persistence/ttl-cache.js";
import { customerAdded, type AddedWhere } from "../domain/added-where.js";

/** Spaces tidied: "  Maria   Santos " → "Maria Santos". */
export const cleanName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, 80);

/**
 * The store customer for this name (and mobile, if given): an existing one when it matches, else a new one.
 * `where`: the store, login and screen it is made at, kept on a NEW customer only (an existing one keeps its own).
 */
export async function findOrMakeQuickCustomer(storeId: string, name: string, phone?: string | null, where?: AddedWhere | null): Promise<string | null> {
  const n = cleanName(name ?? "");
  if (!n) return null;
  const tel = phone?.trim() || null;
  let customerId: string | null = null;
  if (tel) customerId = (await prisma.customer.findFirst({ where: { phone: tel }, select: { id: true } }))?.id ?? null;
  if (!customerId) {
    // A customer of this store with the same name is the same person: with a mobile typed now, only one
    // that has no mobile yet (it gets this one), so "Maria" saved earlier without a number is not made twice.
    const same = await prisma.storeCustomer.findFirst({
      where: { storeId, customer: { name: { equals: n, mode: "insensitive" }, ...(tel ? { phone: null } : {}) } },
      orderBy: { createdAt: "asc" }, select: { id: true, customerId: true },
    });
    if (same) {
      if (tel) {
        await prisma.customer.update({ where: { id: same.customerId }, data: { phone: tel } });
        await cacheBust(cacheKey("customers", storeId));
      }
      return same.id;
    }
  }
  if (!customerId) customerId = (await prisma.customer.create({ data: { name: n, phone: tel, email: null, passwordHash: null } })).id;
  const sc = await prisma.storeCustomer.upsert({
    where: { storeId_customerId: { storeId, customerId } },
    update: {},
    create: { storeId, customerId, ...customerAdded(where) },
  });
  await cacheBust(cacheKey("customers", storeId));
  return sc.id;
}
