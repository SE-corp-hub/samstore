// Customer auth — password-based customer accounts (email + password).
// Issues a JWT with role CUSTOMER; the customer's per-store loyalty/profile is
// created lazily at checkout / claim (guests remain anonymous).

import { prisma } from "../persistence/prisma-repositories.js";
import { hashPassword, verifyPassword, signToken, verifyToken, type AuthConfig } from "./auth.domain.js";
import type { ApiError } from "@sam-store/contracts";

export type CustomerAuthResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** DI token. */
export const CUSTOMER_AUTH_SERVICE = Symbol("CUSTOMER_AUTH_SERVICE");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class CustomerAuthService {
  constructor(private readonly config: AuthConfig) {}

  async register(input: { email: string; password: string; name?: string; phone?: string }): Promise<
    CustomerAuthResult<{ token: string; customer: { id: string; email: string; name: string | null } }>
  > {
    const email = input.email?.trim().toLowerCase() ?? "";
    if (!EMAIL_RE.test(email)) {
      return { ok: false, error: { type: "validation", errors: ["A valid email is required"] } };
    }
    if (!input.password || input.password.length < 8) {
      return { ok: false, error: { type: "validation", errors: ["Password must be at least 8 characters"] } };
    }
    const existing = await prisma.customer.findFirst({ where: { email } });
    if (existing) return { ok: false, error: { type: "conflict", message: "Email already registered" } };

    const passwordHash = await hashPassword(input.password);
    const customer = await prisma.customer.create({
      data: { email, passwordHash, name: input.name?.trim() ?? null, phone: input.phone?.trim() ?? null },
    });

    const token = signToken({ sub: customer.id, role: "CUSTOMER", email: customer.email ?? "" }, this.config);
    return { ok: true, value: { token, customer: { id: customer.id, email: customer.email ?? "", name: customer.name } } };
  }

  async login(input: { email: string; password: string }): Promise<
    CustomerAuthResult<{ token: string; customer: { id: string; email: string; name: string | null } }>
  > {
    const email = input.email?.trim().toLowerCase() ?? "";
    const customer = await prisma.customer.findFirst({ where: { email } });
    if (!customer || !customer.passwordHash) {
      return { ok: false, error: { type: "unauthorized", message: "Invalid email or password" } };
    }
    const valid = await verifyPassword(input.password ?? "", customer.passwordHash);
    if (!valid) return { ok: false, error: { type: "unauthorized", message: "Invalid email or password" } };

    const token = signToken({ sub: customer.id, role: "CUSTOMER", email: customer.email ?? "" }, this.config);
    return { ok: true, value: { token, customer: { id: customer.id, email: customer.email ?? "", name: customer.name } } };
  }

  /** U6 — customer account overview: profile + loyalty + credit + recent orders for a store. */
  async me(customerToken: string, storeId?: string): Promise<CustomerAuthResult<{
    customer: { id: string; email: string; name: string | null; phone: string | null };
    profile: {
      storeId: string;
      loyaltyPoints: number;
      creditApproved: boolean;
      creditLimitMinor: number;
      creditBalanceMinor: number;
      approvalStatus: string;
    } | null;
    orders: { id: string; orderNumber: string; status: string; totalMinor: number; deliveryType: string; createdAt: string; claimToken: string | null }[];
  }>> {
    let decoded: { sub: string; role: string };
    try {
      decoded = verifyToken(customerToken, this.config) as { sub: string; role: string };
    } catch {
      return { ok: false, error: { type: "unauthorized", message: "Invalid customer token" } };
    }
    if (decoded.role !== "CUSTOMER") {
      return { ok: false, error: { type: "unauthorized", message: "Not a customer account" } };
    }
    const customer = await prisma.customer.findUnique({ where: { id: decoded.sub } });
    if (!customer) return { ok: false, error: { type: "not_found", message: "Customer not found" } };

    const sc = storeId
      ? await prisma.storeCustomer.findUnique({ where: { storeId_customerId: { storeId, customerId: customer.id } } })
      : await prisma.storeCustomer.findFirst({ where: { customerId: customer.id } });
    if (!sc) {
      return {
        ok: true,
        value: {
          customer: { id: customer.id, email: customer.email ?? "", name: customer.name, phone: customer.phone },
          profile: null,
          orders: [],
        },
      };
    }
    const orders = await prisma.order.findMany({
      where: { storeId: sc.storeId, storeCustomerId: sc.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, orderNumber: true, status: true, totalMinor: true, deliveryType: true, createdAt: true, claimTokens: { where: { usedAt: null }, take: 1, select: { token: true } } },
    });
    return {
      ok: true,
      value: {
        customer: { id: customer.id, email: customer.email ?? "", name: customer.name, phone: customer.phone },
        profile: {
          storeId: sc.storeId,
          loyaltyPoints: sc.loyaltyBalancePoints,
          creditApproved: sc.creditApproved,
          creditLimitMinor: sc.creditLimitMinor,
          creditBalanceMinor: sc.creditBalanceMinor,
          approvalStatus: sc.approvalStatus,
        },
        orders: orders.map((o) => ({ id: o.id, orderNumber: o.orderNumber, status: o.status, totalMinor: o.totalMinor, deliveryType: o.deliveryType, createdAt: o.createdAt.toISOString(), claimToken: o.claimTokens[0]?.token ?? null })),
      },
    };
  }
}