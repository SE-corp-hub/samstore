// Customer auth — password-based customer accounts (email + password).
// Issues a JWT with role CUSTOMER; the customer's per-store loyalty/profile is
// created lazily at checkout / claim (guests remain anonymous).
// P1.portal: saved addresses (tenant-scoped via the store profile, PH-chain
// validated + name snapshots) and DPA consent records (RA 10173, append-only).

import { prisma } from "../persistence/prisma-repositories.js";
import { hashPassword, verifyPassword, signToken, verifyToken, type AuthConfig } from "./auth.domain.js";
import { AddressService } from "../address/address.service.js";
import type { ApiError } from "@sam-store/contracts";

export type CustomerAuthResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

/** DI token. */
export const CUSTOMER_AUTH_SERVICE = Symbol("CUSTOMER_AUTH_SERVICE");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SavedAddressInput {
  label?: string;
  addressLine1?: string;
  addressLine2?: string;
  landmark?: string;
  instructions?: string;
  regionCode?: string;
  provinceCode?: string;
  cityCode?: string;
  barangayCode?: string;
  isDefault?: boolean;
}

export interface ConsentInput {
  scope: string;
  channel: string; // web | messenger | pos | email | sms
  granted?: boolean;
  version?: string;
}

const ADDRESS_CODE_KEYS = ["regionCode", "provinceCode", "cityCode", "barangayCode"] as const;
type Code = (typeof ADDRESS_CODE_KEYS)[number];
type NameKey = "regionName" | "provinceName" | "cityName" | "barangayName";

export class CustomerAuthService {
  private static readonly CONFIG_ERROR: ApiError = { type: "unauthorized", message: "Invalid customer token" };

  constructor(
    private readonly config: AuthConfig,
    private readonly addresses: AddressService,
  ) {}

  private verifyCustomerToken(token: string): { customer: { id: string } } | { ok: false; error: ApiError } {
    let decoded: { sub: string; role: string };
    try {
      decoded = verifyToken(token, this.config) as { sub: string; role: string };
    } catch {
      return { ok: false, error: CustomerAuthService.CONFIG_ERROR };
    }
    if (decoded.role !== "CUSTOMER") {
      return { ok: false, error: { type: "unauthorized", message: "Not a customer account" } };
    }
    return { customer: { id: decoded.sub } };
  }

  private async loadCustomer(id: string): Promise<{ id: string; email: string | null; phone: string | null; name: string | null } | null> {
    return prisma.customer.findUnique({ where: { id }, select: { id: true, email: true, phone: true, name: true } });
  }

  /** Resolve the store profile for a customer + store (tenant boundary for addresses). */
  private async storeProfile(customerId: string, storeId: string | undefined) {
    if (!storeId || typeof storeId !== "string" || storeId.length === 0) {
      return null;
    }
    return prisma.storeCustomer.findUnique({ where: { storeId_customerId: { storeId, customerId } } });
  }

  /** Like storeProfile, but lazily creates the per-store profile so a brand-new
   *  customer can save an address before their first order. */
  private async ensureProfile(customerId: string, storeId: string) {
    const existing = await this.storeProfile(customerId, storeId);
    if (existing) return existing;
    if (!storeId || typeof storeId !== "string" || storeId.length === 0) return null;
    return prisma.storeCustomer.create({
      data: { storeId, customerId },
    });
  }

  /** All-or-nothing PH chain resolution for a saved-address input → { changed, codes, names } or an ApiError. */
  private async resolveCodes(input: SavedAddressInput): Promise<
    { ok: true; changed: boolean; codes: Record<Code, string | null>; names: Record<NameKey, string | null> } | { ok: false; error: ApiError }
  > {
    const present = ADDRESS_CODE_KEYS.filter((k) => input[k]?.trim());
    if (present.length === 0) {
      return { ok: true, changed: false, codes: { regionCode: null, provinceCode: null, cityCode: null, barangayCode: null }, names: { regionName: null, provinceName: null, cityName: null, barangayName: null } };
    }
    if (present.length !== ADDRESS_CODE_KEYS.length) {
      return {
        ok: false,
        error: {
          type: "validation",
          errors: ["Complete the full address (region, province, city/municipality, barangay)"],
        },
      };
    }
    const [regionValue = "", provinceValue = "", cityValue = "", barangayValue = ""] = present.map((k) => (input[k] ?? "").trim());
    const resolved = await this.addresses.resolve(regionValue, provinceValue, cityValue, barangayValue);
    if (!resolved.ok) {
      return { ok: false, error: { type: "validation", errors: [resolved.message] } };
    }
    return {
      ok: true,
      changed: true,
      codes: { regionCode: regionValue, provinceCode: provinceValue, cityCode: cityValue, barangayCode: barangayValue },
      names: {
        regionName: resolved.names.regionName,
        provinceName: resolved.names.provinceName,
        cityName: resolved.names.cityName,
        barangayName: resolved.names.barangayName,
      },
    };
  }

  async register(input: { email: string; password: string; name?: string; phone?: string; consent?: ConsentInput }): Promise<
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
      data: {
        email,
        passwordHash,
        name: input.name?.trim() ?? null,
        phone: input.phone?.trim() ?? null,
        ...(input.consent?.scope
          ? { consents: { create: { scope: input.consent.scope, channel: input.consent.channel ?? "web", granted: input.consent.granted ?? true, version: input.consent.version ?? null } } }
          : {}),
      },
      include: { consents: true },
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

  // ─────────────────────────── Saved addresses (P1.portal) ───────────────────────────

  async listAddresses(customerToken: string, storeId: string): Promise<CustomerAuthResult<{
    addresses: {
      id: string;
      label: string | null;
      addressLine1: string | null;
      addressLine2: string | null;
      landmark: string | null;
      instructions: string | null;
      regionCode: string | null;
      provinceCode: string | null;
      cityCode: string | null;
      barangayCode: string | null;
      regionName: string | null;
      provinceName: string | null;
      cityName: string | null;
      barangayName: string | null;
      isDefault: boolean;
    }[];
  }>> {
    const auth = this.verifyCustomerToken(customerToken);
    if ("ok" in auth) return { ok: false, error: auth.error };
    const customer = await this.loadCustomer(auth.customer.id);
    if (!customer) return { ok: false, error: { type: "not_found", message: "Customer not found" } };
    const sc = await this.ensureProfile(customer.id, storeId);
    if (!sc) return { ok: false, error: { type: "validation", errors: ["storeId is required"] } };

    const addresses = await prisma.storeCustomerAddress.findMany({
      where: { storeId: sc.storeId, storeCustomerId: sc.id },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    });
    return {
      ok: true,
      value: {
        addresses: addresses.map((a) => ({
          id: a.id,
          label: a.label,
          addressLine1: a.addressLine1,
          addressLine2: a.addressLine2,
          landmark: a.landmark,
          instructions: a.instructions,
          regionCode: a.regionCode,
          provinceCode: a.provinceCode,
          cityCode: a.cityCode,
          barangayCode: a.barangayCode,
          regionName: a.regionName,
          provinceName: a.provinceName,
          cityName: a.cityName,
          barangayName: a.barangayName,
          isDefault: a.isDefault,
        })),
      },
    };
  }

  async createAddress(customerToken: string, storeId: string, input: SavedAddressInput): Promise<CustomerAuthResult<{ address: { id: string } }>> {
    const auth = this.verifyCustomerToken(customerToken);
    if ("ok" in auth) return { ok: false, error: auth.error };
    const customer = await this.loadCustomer(auth.customer.id);
    if (!customer) return { ok: false, error: { type: "not_found", message: "Customer not found" } };
    const sc = await this.ensureProfile(customer.id, storeId);
    if (!sc) return { ok: false, error: { type: "validation", errors: ["storeId is required"] } };

    const resolved = await this.resolveCodes(input);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (input.addressLine1 !== undefined && input.addressLine1.length > 200) {
      return { ok: false, error: { type: "validation", errors: ["addressLine1 must be at most 200 characters"] } };
    }
    if (input.label !== undefined && input.label.length > 60) {
      return { ok: false, error: { type: "validation", errors: ["label must be at most 60 characters"] } };
    }

    const count = await prisma.storeCustomerAddress.count({ where: { storeId: sc.storeId, storeCustomerId: sc.id } });
    const makeDefault = input.isDefault === true || count === 0;

    const created = await prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.storeCustomerAddress.updateMany({
          where: { storeId: sc.storeId, storeCustomerId: sc.id, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.storeCustomerAddress.create({
        data: {
          storeId: sc.storeId,
          storeCustomerId: sc.id,
          label: input.label?.trim() || null,
          addressLine1: input.addressLine1?.trim() || null,
          addressLine2: input.addressLine2?.trim() || null,
          landmark: input.landmark?.trim() || null,
          instructions: input.instructions?.trim() || null,
          ...resolved.codes,
          ...resolved.names,
          isDefault: makeDefault,
        },
        select: { id: true },
      });
    });

    return { ok: true, value: { address: { id: created.id } } };
  }

  async updateAddress(customerToken: string, storeId: string, addressId: string, input: SavedAddressInput): Promise<CustomerAuthResult<{ ok: true }>> {
    const auth = this.verifyCustomerToken(customerToken);
    if ("ok" in auth) return { ok: false, error: auth.error };
    const customer = await this.loadCustomer(auth.customer.id);
    if (!customer) return { ok: false, error: { type: "not_found", message: "Customer not found" } };
    const sc = await this.ensureProfile(customer.id, storeId);
    if (!sc) return { ok: false, error: { type: "validation", errors: ["storeId is required"] } };

    const existing = await prisma.storeCustomerAddress.findFirst({
      where: { id: addressId, storeId: sc.storeId, storeCustomerId: sc.id },
    });
    if (!existing) return { ok: false, error: { type: "not_found", message: "Address not found" } };

    const resolved = await this.resolveCodes(input);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    await prisma.$transaction(async (tx) => {
      if (input.isDefault === true) {
        await tx.storeCustomerAddress.updateMany({
          where: { storeId: sc.storeId, storeCustomerId: sc.id, isDefault: true, id: { not: addressId } },
          data: { isDefault: false },
        });
      }
      await tx.storeCustomerAddress.update({
        where: { id: addressId },
        data: {
          label: input.label !== undefined ? input.label.trim() || null : undefined,
          addressLine1: input.addressLine1 !== undefined ? input.addressLine1.trim() || null : undefined,
          addressLine2: input.addressLine2 !== undefined ? input.addressLine2.trim() || null : undefined,
          landmark: input.landmark !== undefined ? input.landmark.trim() || null : undefined,
          instructions: input.instructions !== undefined ? input.instructions.trim() || null : undefined,
          isDefault: input.isDefault !== undefined ? input.isDefault : undefined,
          // PH codes change together or not at all (all-or-nothing).
          ...(resolved.changed
            ? {
                regionCode: resolved.codes.regionCode,
                provinceCode: resolved.codes.provinceCode,
                cityCode: resolved.codes.cityCode,
                barangayCode: resolved.codes.barangayCode,
                regionName: resolved.names.regionName,
                provinceName: resolved.names.provinceName,
                cityName: resolved.names.cityName,
                barangayName: resolved.names.barangayName,
              }
            : {}),
        },
      });
    });
    return { ok: true, value: { ok: true } };
  }

  async deleteAddress(customerToken: string, storeId: string, addressId: string): Promise<CustomerAuthResult<{ ok: true }>> {
    const auth = this.verifyCustomerToken(customerToken);
    if ("ok" in auth) return { ok: false, error: auth.error };
    const customer = await this.loadCustomer(auth.customer.id);
    if (!customer) return { ok: false, error: { type: "not_found", message: "Customer not found" } };
    const sc = await this.ensureProfile(customer.id, storeId);
    if (!sc) return { ok: false, error: { type: "validation", errors: ["storeId is required"] } };

    const existing = await prisma.storeCustomerAddress.findFirst({
      where: { id: addressId, storeId: sc.storeId, storeCustomerId: sc.id },
    });
    if (!existing) return { ok: false, error: { type: "not_found", message: "Address not found" } };

    await prisma.storeCustomerAddress.delete({ where: { id: addressId } });
    return { ok: true, value: { ok: true } };
  }

  // ─────────────────────────────── Consent (DPA / RA 10173) ───────────────────────────────

  async recordConsent(customerToken: string, input: ConsentInput): Promise<CustomerAuthResult<{ ok: true }>> {
    const auth = this.verifyCustomerToken(customerToken);
    if ("ok" in auth) return { ok: false, error: auth.error };
    const customer = await this.loadCustomer(auth.customer.id);
    if (!customer) return { ok: false, error: { type: "not_found", message: "Customer not found" } };
    if (!input.scope || input.scope.trim().length === 0 || input.scope.length > 60) {
      return { ok: false, error: { type: "validation", errors: ["scope is required"] } };
    }
    const channel = input.channel?.trim() || "web";
    await prisma.consentRecord.create({
      data: { customerId: customer.id, scope: input.scope.trim(), channel, granted: input.granted ?? true, version: input.version?.trim() || null, recordedBy: customer.id },
    });
    return { ok: true, value: { ok: true } };
  }

  async listConsents(customerToken: string): Promise<CustomerAuthResult<{
    consents: { id: string; scope: string; channel: string; granted: boolean; version: string | null; createdAt: string }[];
  }>> {
    const auth = this.verifyCustomerToken(customerToken);
    if ("ok" in auth) return { ok: false, error: auth.error };
    const customer = await this.loadCustomer(auth.customer.id);
    if (!customer) return { ok: false, error: { type: "not_found", message: "Customer not found" } };
    const consents = await prisma.consentRecord.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: "desc" } });
    return {
      ok: true,
      value: { consents: consents.map((c) => ({ id: c.id, scope: c.scope, channel: c.channel, granted: c.granted, version: c.version, createdAt: c.createdAt.toISOString() })) },
    };
  }
}