// Runtime DTO validation at the API boundary (Module 2 fix).
// NestJS is used WITHOUT class-validator/class-transformer here, so request bodies
// were previously trusted and only checked (unevenly) inside services. This module
// gives every untrusted boundary — public storefront, cart, checkout, claim, auth —
// the same dependency-free schema check, returning the ApiError "validation" shape
// so the UI can show field-level messages instead of a 500.
//
// Rule of thumb: validate SHAPE and TYPES here (and reject unknown keys — a typo
// silently dropped is how client-controlled fields sneak in); business rules stay
// in the domain services.

export interface StringRule {
  kind: "string";
  required?: boolean;
  min?: number;
  max?: number;
  /** Exact allowed values (enum). */
  values?: readonly string[];
  pattern?: RegExp;
  patternMessage?: string;
  trim?: boolean;
}

export interface IntRule {
  kind: "int";
  required?: boolean;
  min?: number;
  max?: number;
}

export interface BoolRule {
  kind: "bool";
  required?: boolean;
}

export interface ObjectRule {
  kind: "object";
  fields: Record<string, Rule>;
  /** Reject keys that are not declared (default true). */
  allowUnknown?: boolean;
}

export type Rule = StringRule | IntRule | BoolRule | ObjectRule | ArrayRule;

/** A list of items validated one by one (each item may itself be an object rule). */
export interface ArrayRule {
  kind: "array";
  required?: boolean;
  /** Minimum number of items. */
  min?: number;
  /** Maximum number of items. */
  max?: number;
  item: Rule;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function checkOne(value: unknown, rule: Rule, path: string, errors: string[]): unknown {
  switch (rule.kind) {
    case "string": {
      if (value === undefined || value === null || value === "") {
        if (rule.required) errors.push(`${path} is required`);
        return undefined;
      }
      if (typeof value !== "string") {
        errors.push(`${path} must be a string`);
        return undefined;
      }
      const v = rule.trim === false ? value : value.trim();
      if (rule.min !== undefined && v.length < rule.min) {
        errors.push(`${path} must be at least ${rule.min} characters`);
        return undefined;
      }
      if (rule.max !== undefined && v.length > rule.max) {
        errors.push(`${path} must be at most ${rule.max} characters`);
        return undefined;
      }
      if (rule.values && !rule.values.includes(v)) {
        errors.push(`${path} must be one of: ${rule.values.join(", ")}`);
        return undefined;
      }
      if (rule.pattern && !rule.pattern.test(v)) {
        errors.push(rule.patternMessage ?? `${path} has an invalid format`);
        return undefined;
      }
      return v;
    }
    case "int": {
      if (value === undefined || value === null || value === "") {
        if (rule.required) errors.push(`${path} is required`);
        return undefined;
      }
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push(`${path} must be an integer`);
        return undefined;
      }
      if (rule.min !== undefined && value < rule.min) {
        errors.push(`${path} must be at least ${rule.min}`);
        return undefined;
      }
      if (rule.max !== undefined && value > rule.max) {
        errors.push(`${path} must be at most ${rule.max}`);
        return undefined;
      }
      return value;
    }
    case "bool": {
      if (value === undefined || value === null) {
        if (rule.required) errors.push(`${path} is required`);
        return undefined;
      }
      if (typeof value !== "boolean") {
        errors.push(`${path} must be a boolean`);
        return undefined;
      }
      return value;
    }
    case "object": {
      if (value === undefined || value === null) {
        errors.push(`${path} is required`);
        return undefined;
      }
      if (typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path} must be an object`);
        return undefined;
      }
      // N2 fix: the nested check builds its OWN error list — forward those errors to the
      // outer one, otherwise an invalid nested object is silently DROPPED and the whole
      // DTO reports ok:true (found by the array-rule test: amountMinor 0 was accepted).
      const nested = checkDto(value as Record<string, unknown>, rule, path);
      if (!nested.ok) {
        errors.push(...nested.errors);
        return undefined;
      }
      return value as Record<string, unknown>;
    }
    case "array": {
      if (value === undefined || value === null) {
        if (rule.required) errors.push(`${path} is required`);
        return undefined;
      }
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
        return undefined;
      }
      if (rule.min !== undefined && value.length < rule.min) {
        errors.push(`${path} must have at least ${rule.min} item(s)`);
        return undefined;
      }
      if (rule.max !== undefined && value.length > rule.max) {
        errors.push(`${path} must have at most ${rule.max} item(s)`);
        return undefined;
      }
      const out: unknown[] = [];
      value.forEach((item, i) => {
        const checked = checkOne(item, rule.item, `${path}[${i}]`, errors);
        if (checked !== undefined) out.push(checked);
      });
      return out;
    }
  }
}

/** Validate an object against declared fields. Collects ALL errors, not just the first. */
export function checkDto<T = Record<string, unknown>>(
  input: unknown,
  rule: ObjectRule,
  pathPrefix = "",
): ValidationResult<T> {
  const errors: string[] = [];
  if (input === undefined || input === null) {
    return { ok: false, errors: [pathPrefix ? `${pathPrefix} is required` : "body is required"] };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [pathPrefix ? `${pathPrefix} must be an object` : "body must be an object"] };
  }

  const raw = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, fieldRule] of Object.entries(rule.fields)) {
    const value = checkOne(raw[key], fieldRule, pathPrefix ? `${pathPrefix}.${key}` : key, errors);
    if (value !== undefined) out[key] = value;
  }

  if (rule.allowUnknown === false || rule.allowUnknown === undefined) {
    for (const key of Object.keys(raw)) {
      if (!(key in rule.fields)) {
        errors.push(pathPrefix ? `${pathPrefix}.${key} is not an allowed field` : `${key} is not an allowed field`);
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out as T };
}

// ── shared schemas for the untrusted public/auth surface ──────────────────────
import { HttpException, HttpStatus } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";

/**
 * Validate-or-throw for a controller boundary: bad shape → 422 in the standard
 * ApiError "validation" form (the UI shows `errors`), never a 500.
 */
export function assertDto<T>(input: unknown, rule: ObjectRule): T {
  const result = checkDto<T>(input, rule);
  if (!result.ok) {
    const error: ApiError = { type: "validation", errors: result.errors };
    throw new HttpException(error, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  return result.value;
}


export const CHECKOUT_DTO: ObjectRule = {
  kind: "object",
  fields: {
    cartToken: { kind: "string", required: true, min: 8, max: 200 },
    customerName: { kind: "string", required: true, min: 2, max: 120 },
    customerPhone: { kind: "string", required: true, min: 7, max: 32 },
    deliveryType: { kind: "string", values: ["delivery", "pickup"] },
    paymentMethod: { kind: "string", values: ["cod", "credit"] },
    idempotencyKey: { kind: "string", required: true, min: 8, max: 200 },
    deliveryAddressLine1: { kind: "string", max: 200 },
    deliveryAddressLine2: { kind: "string", max: 200 },
    landmark: { kind: "string", max: 200 },
    deliverySchedule: { kind: "string", max: 120 },
    notes: { kind: "string", max: 500 },
    voucherCode: { kind: "string", max: 64 },
    customerToken: { kind: "string", max: 4096 },
    loyaltyPoints: { kind: "int", min: 0, max: 10_000_000 },
  },
};

export const CART_ADD_DTO: ObjectRule = {
  kind: "object",
  fields: {
    productId: { kind: "string", required: true, min: 8, max: 64 },
    quantity: { kind: "int", required: true, min: 1, max: 999 },
    // P2a: optional variant line + add-on selections (details resolved server-side).
    variantId: { kind: "string", max: 200 },
    addons: {
      kind: "array",
      max: 20,
      item: {
        kind: "object",
        fields: {
          addonId: { kind: "string", required: true, min: 1, max: 200 },
          optionId: { kind: "string", required: true, min: 1, max: 200 },
        },
      },
    },
  },
};

export const CART_QTY_DTO: ObjectRule = {
  kind: "object",
  fields: { quantity: { kind: "int", required: true, min: 0, max: 999 } },
};

export const CLAIM_DTO: ObjectRule = {
  kind: "object",
  fields: { claimToken: { kind: "string", required: true, min: 8, max: 4096 } },
};

export const LOGIN_DTO: ObjectRule = {
  kind: "object",
  fields: {
    // A1: identifier = phone (E.164, normalized in service) or email. `email` is
    // still accepted as a transitional alias for the same field.
    identifier: { kind: "string", required: false, min: 3, max: 254 },
    email: { kind: "string", required: false, min: 3, max: 254 },
    password: { kind: "string", required: true, min: 1, max: 200, trim: false },
  },
};

export const REGISTER_DTO: ObjectRule = {
  kind: "object",
  fields: {
    email: { kind: "string", required: false, min: 3, max: 254 },
    phone: { kind: "string", required: false, min: 5, max: 20, trim: true },
    password: { kind: "string", required: true, min: 8, max: 200, trim: false },
    name: { kind: "string", max: 120 },
  },
};

export const CHANGE_PASSWORD_DTO: ObjectRule = {
  kind: "object",
  fields: {
    email: { kind: "string", required: true, min: 3, max: 254 },
    currentPassword: { kind: "string", required: true, min: 1, max: 200, trim: false },
    newPassword: { kind: "string", required: true, min: 8, max: 200, trim: false },
  },
};

// ── N1: cash drawer / shifts ──────────────────────────────────────────────────
export const OPEN_SHIFT_DTO: ObjectRule = {
  kind: "object",
  fields: {
    openingFloatMinor: { kind: "int", min: 0, max: 100_000_000 },
    notes: { kind: "string", max: 300 },
  },
};

export const CASH_MOVEMENT_DTO: ObjectRule = {
  kind: "object",
  fields: {
    type: { kind: "string", required: true, values: ["FLOAT", "CASH_IN", "CASH_OUT", "REFUND"] },
    amountMinor: { kind: "int", required: true, min: 1, max: 100_000_000 },
    reason: { kind: "string", max: 300 },
  },
};

export const CLOSE_SHIFT_DTO: ObjectRule = {
  kind: "object",
  fields: {
    countedMinor: { kind: "int", required: true, min: 0, max: 1_000_000_000 },
    notes: { kind: "string", max: 300 },
  },
};

// ── N2: split payments + payment methods ──────────────────────────────────────
export const SPLIT_PAYMENT_DTO: ObjectRule = {
  kind: "object",
  fields: {
    idempotencyKey: { kind: "string", required: true, min: 8, max: 200 },
    note: { kind: "string", max: 300 },
    tenders: {
      kind: "array",
      required: true,
      min: 1,
      max: 8,
      item: {
        kind: "object",
        fields: {
          methodCode: { kind: "string", required: true, min: 2, max: 32 },
          amountMinor: { kind: "int", required: true, min: 1, max: 1_000_000_000 },
          tenderedMinor: { kind: "int", min: 1, max: 1_000_000_000 },
          reference: { kind: "string", max: 64 },
        },
      },
    },
  },
};

// ── M2: stock adjustments ─────────────────────────────────────────────────────
export const STOCK_ADJUST_DTO: ObjectRule = {
  kind: "object",
  fields: {
    productId: { kind: "string", required: true, min: 6, max: 64 },
    warehouseId: { kind: "string", min: 6, max: 64 },
    // One of delta / setTo (enforced in the service so the error message is human).
    delta: { kind: "int", min: -1_000_000, max: 1_000_000 },
    setTo: { kind: "int", min: 0, max: 1_000_000 },
    reason: { kind: "string", required: true, min: 3, max: 200 },
    allowNegative: { kind: "bool" },
  },
};

export const PAYMENT_METHOD_DTO: ObjectRule = {
  kind: "object",
  fields: {
    code: { kind: "string", required: true, min: 2, max: 32 },
    label: { kind: "string", required: true, min: 1, max: 60 },
    kind: { kind: "string", values: ["CASH", "CREDIT", "EWALLET", "TRANSFER", "OTHER", "cash", "credit", "ewallet", "transfer", "other"] },
    requiresReference: { kind: "bool" },
    enabled: { kind: "bool" },
    sortOrder: { kind: "int", min: 0, max: 999 },
  },
};
