// P5a: delivery zones admin — tenant-scoped CRUD for per-zone delivery pricing.
// A null cityCode is the catch-all "everywhere else" zone; barangayCodes is an
// optional allowlist within the city (empty = whole city).

import { prisma } from "../persistence/prisma-repositories.js";
import type { ApiError } from "@sam-store/contracts";

export type ZoneAdminResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface DeliveryZoneInput {
  name: string;
  cityCode?: string | null;
  barangayCodes?: string[];
  feeMinor: number;
  etaMinutes?: number;
  isActive?: boolean;
  sortOrder?: number;
}

export class DeliveryZonesAdminService {
  async list(storeId: string) {
    return prisma.deliveryZone.findMany({
      where: { storeId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
  }

  async upsert(storeId: string, id: string | null, input: DeliveryZoneInput): Promise<ZoneAdminResult<{ id: string }>> {
    const name = input.name?.trim();
    if (!name || name.length > 80) return { ok: false, error: { type: "validation", errors: ["name is required (max 80 chars)"] } };
    if (!Number.isInteger(input.feeMinor) || input.feeMinor < 0) return { ok: false, error: { type: "validation", errors: ["feeMinor must be a non-negative integer"] } };
    const eta = input.etaMinutes ?? 45;
    if (!Number.isInteger(eta) || eta < 1 || eta > 1440) return { ok: false, error: { type: "validation", errors: ["etaMinutes must be 1–1440"] } };
    const barangays = (input.barangayCodes ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
    if (barangays.length > 200) return { ok: false, error: { type: "validation", errors: ["too many barangay codes (max 200)"] } };

    if (id) {
      const existing = await prisma.deliveryZone.findFirst({ where: { id, storeId } });
      if (!existing) return { ok: false, error: { type: "not_found", message: "Delivery zone not found" } };
      const dup = await prisma.deliveryZone.findFirst({ where: { storeId, name, id: { not: id } } });
      if (dup) return { ok: false, error: { type: "conflict", message: "A zone with this name already exists" } };
      await prisma.deliveryZone.update({
        where: { id },
        data: {
          name,
          cityCode: input.cityCode?.trim() || null,
          barangayCodes: barangays,
          feeMinor: input.feeMinor,
          etaMinutes: eta,
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        },
      });
      return { ok: true, value: { id } };
    }

    const dup = await prisma.deliveryZone.findFirst({ where: { storeId, name } });
    if (dup) return { ok: false, error: { type: "conflict", message: "A zone with this name already exists" } };
    const created = await prisma.deliveryZone.create({
      data: {
        storeId,
        name,
        cityCode: input.cityCode?.trim() || null,
        barangayCodes: barangays,
        feeMinor: input.feeMinor,
        etaMinutes: eta,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    return { ok: true, value: { id: created.id } };
  }

  async remove(storeId: string, id: string): Promise<ZoneAdminResult<{ ok: true }>> {
    const existing = await prisma.deliveryZone.findFirst({ where: { id, storeId } });
    if (!existing) return { ok: false, error: { type: "not_found", message: "Delivery zone not found" } };
    await prisma.deliveryZone.delete({ where: { id } });
    return { ok: true, value: { ok: true } };
  }
}