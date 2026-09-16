// Store admin service — multi-store: create stores, assign owners, list.

import { randomBytes } from "node:crypto";
import { prisma } from "../persistence/prisma-repositories.js";
import { StoreRole, StoreStatus } from "@prisma/client";
import type { ApiError } from "@sam-store/contracts";

export type AdminResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** v6 A1 — legal store access statuses. */
export const STORE_STATUSES = ["ACTIVE", "SUSPENDED", "ARCHIVED", "CLOSED"] as const;

export interface CreateStoreInput {
  name: string;
  slug: string;
  currencyCode?: string;
  timezone?: string;
  ownerEmail: string; // existing User (store owner) to bind
  ownerRole?: string;
}

export class StoreAdminService {
  /** List all stores (platform admin). */
  async listAll() {
    return prisma.store.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        currencyCode: true,
        timezone: true,
        createdAt: true,
        _count: { select: { products: true, orders: true } },
      },
    });
  }

  /** Create a store + settings + public link + bind the owner membership. */
  async create(input: CreateStoreInput): Promise<AdminResult<{ id: string }>> {
    const name = input.name?.trim() ?? "";
    const slug = input.slug?.trim().toLowerCase() ?? "";
    if (name.length < 2) return { ok: false, error: { type: "validation", errors: ["Store name must be at least 2 characters"] } };
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      return { ok: false, error: { type: "validation", errors: ["Slug must be 2-40 chars: lowercase letters, digits, hyphens"] } };
    }

    const existingSlug = await prisma.store.findUnique({ where: { slug } });
    if (existingSlug) return { ok: false, error: { type: "conflict", message: "A store with this slug already exists" } };

    const owner = await prisma.user.findUnique({ where: { email: input.ownerEmail.toLowerCase() } });
    if (!owner) return { ok: false, error: { type: "not_found", message: "Owner email must be a registered admin user" } };

    const token = `lnk_${randomBytes(24).toString("base64url")}`;
    const store = await prisma.store.create({
      data: {
        name,
        slug,
        currencyCode: input.currencyCode ?? "PHP",
        timezone: input.timezone ?? "Asia/Manila",
        status: "ACTIVE",
        settings: { create: {} },
        publicLink: { create: { slug, token } },
        userStores: {
          create: { userId: owner.id, role: (input.ownerRole ?? "OWNER") as StoreRole },
        },
      },
    });
    return { ok: true, value: { id: store.id } };
  }

  /** v6 A1 — set the store's access status (suspend/reinstate/archive/close). Audited via StoreStatusHistory. */
  async setStatus(
    storeId: string,
    from: string | null,
    to: string,
    reason?: string | null,
    actorId?: string | null,
  ): Promise<
    AdminResult<{
      id: string;
      status: string;
      fromStatus: string | null;
      changedBy: string | null;
      reason: string | null;
      changedAt: Date;
    }>
  > {
    if (!(STORE_STATUSES as readonly string[]).includes(to)) {
      return {
        ok: false,
        error: { type: "validation", errors: [`store status must be one of: ${STORE_STATUSES.join(", ")}`] },
      };
    }
    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return { ok: false, error: { type: "not_found", message: "Store not found" } };

    const fromStatus = from ?? store.status;
    const updated = await prisma.store.update({ where: { id: storeId }, data: { status: to as StoreStatus } });
    await prisma.storeStatusHistory.create({
      data: { storeId, fromStatus, toStatus: to, reason: reason ?? null, changedBy: actorId ?? null },
    });
    return {
      ok: true,
      value: {
        id: updated.id,
        status: updated.status,
        fromStatus,
        changedBy: actorId ?? null,
        reason: reason ?? null,
        changedAt: new Date(),
      },
    };
  }

  /** v6 C — per-store data summary (read-only, platform admin). */
  async getDataSummary(storeId: string) {
    const orders = await prisma.order.count({ where: { storeId } });
    const sales = await prisma.order.aggregate({
      where: { storeId, status: { in: ["COMPLETED", "DELIVERED"] } },
      _sum: { totalMinor: true },
    });
    const stock = await prisma.stockLevel.findMany({
      where: { storeId },
      select: { quantityOnHand: true, product: { select: { costMinor: true } } },
    });
    const inventoryValueMinor = stock.reduce((acc, s) => acc + s.quantityOnHand * s.product.costMinor, 0);
    const customers = await prisma.storeCustomer.count({ where: { storeId } });
    const members = await prisma.userStore.count({ where: { storeId, status: "ACTIVE" } });
    const last = await prisma.order.findFirst({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return {
      orders,
      salesTotalMinor: sales._sum.totalMinor ?? 0,
      inventoryValueMinor,
      customers,
      members,
      lastActivityAt: last?.createdAt ?? null,
    };
  }

  /**
   * v6 C — cross-store isolation probe. Calls a store-admin endpoint with the given
   * bearer token + X-Store-Id; a non-200 (401/403/404) proves the token cannot reach
   * that store's data. baseUrl is overridable for tests.
   */
  async isolationProbe(
    probeStoreId: string,
    probeToken: string,
    baseUrl?: string,
  ): Promise<{ isolated: boolean; status: number }> {
    const url = `${baseUrl ?? `http://localhost:${process.env.PORT ?? 4000}`}/admin/orders?status=COMPLETED`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${probeToken}`, "X-Store-Id": probeStoreId },
      });
      const ok = res.status >= 200 && res.status < 300;
      return { isolated: !ok, status: res.status };
    } catch {
      // API unreachable from here — cannot confirm or deny isolation.
      return { isolated: false, status: 0 };
    }
  }
}