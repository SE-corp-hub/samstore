import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type SupplierResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export const SUPPLIERS_SERVICE = Symbol("SUPPLIERS_SERVICE");

export class SuppliersService {
  async list(storeId: string) {
    const suppliers = await prisma.supplier.findMany({
      where: { storeId },
      orderBy: { name: "asc" },
      take: 200,
    });
    return suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      contactPerson: s.contactPerson,
      phone: s.phone,
      email: s.email,
    }));
  }

  async create(storeId: string, name: string, contactPerson?: string, phone?: string, email?: string): Promise<SupplierResult<{ id: string }>> {
    const clean = name?.trim() ?? "";
    if (clean.length < 2) return { ok: false, error: { type: "validation", errors: ["Supplier name must be at least 2 characters"] } };
    const existing = await prisma.supplier.findFirst({ where: { storeId, name: clean } });
    if (existing) return { ok: false, error: { type: "conflict", message: "A supplier with this name already exists" } };

    const supplier = await prisma.supplier.create({
      data: { storeId, name: clean, contactPerson: contactPerson?.trim() ?? null, phone: phone?.trim() ?? null, email: email?.trim() ?? null },
    });
    return { ok: true, value: { id: supplier.id } };
  }

  async upsertByName(storeId: string, vendorName: string): Promise<SupplierResult<{ id: string; name: string }>> {
    const clean = vendorName?.trim() ?? "";
    if (clean.length < 2) return { ok: false, error: { type: "validation", errors: ["Supplier name must be at least 2 characters"] } };
    const existing = await prisma.supplier.findFirst({ where: { storeId, name: clean } });
    if (existing) return { ok: true, value: { id: existing.id, name: existing.name } };
    const created = await prisma.supplier.create({ data: { storeId, name: clean } });
    return { ok: true, value: { id: created.id, name: created.name } };
  }
}