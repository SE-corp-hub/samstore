// Checkout input validation — server-side only, slice scope (COD).
// Returns errors rather than throwing so the API can map them to 4xx responses.

import type { CheckoutRequest } from "@sam-store/contracts";

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;

export function validateCheckoutInput(input: CheckoutRequest): ValidationResult {
  const errors: string[] = [];

  if (!input.customerName || input.customerName.trim().length < 2) {
    errors.push("customerName must be at least 2 characters");
  } else if (input.customerName.length > 120) {
    errors.push("customerName must be at most 120 characters");
  }

  if (!input.customerPhone || !PHONE_RE.test(input.customerPhone.trim())) {
    errors.push("customerPhone must be a valid phone number");
  }

  const deliveryType = input.deliveryType ?? "delivery";
  if (deliveryType !== "delivery" && deliveryType !== "pickup") {
    errors.push("deliveryType must be 'delivery' or 'pickup'");
  }

  // Address required for delivery; optional for pickup.
  if (deliveryType === "delivery") {
    if (!input.deliveryAddressLine1 || input.deliveryAddressLine1.trim().length < 5) {
      errors.push("deliveryAddressLine1 must be at least 5 characters");
    } else if (input.deliveryAddressLine1.length > 200) {
      errors.push("deliveryAddressLine1 must be at most 200 characters");
    }
  } else if (input.deliveryAddressLine1 !== undefined && input.deliveryAddressLine1.length > 200) {
    errors.push("deliveryAddressLine1 must be at most 200 characters");
  }

  if (input.deliveryAddressLine2 !== undefined && input.deliveryAddressLine2.length > 200) {
    errors.push("deliveryAddressLine2 must be at most 200 characters");
  }
  if (input.landmark !== undefined && input.landmark.length > 200) {
    errors.push("landmark must be at most 200 characters");
  }
  if (input.deliverySchedule !== undefined && input.deliverySchedule.length > 100) {
    errors.push("deliverySchedule must be at most 100 characters");
  }
  if (input.notes !== undefined && input.notes.length > 500) {
    errors.push("notes must be at most 500 characters");
  }

  if (input.paymentMethod !== undefined && input.paymentMethod !== "cod" && input.paymentMethod !== "credit") {
    errors.push("paymentMethod must be 'cod' or 'credit'");
  }

  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length < 8) {
    errors.push("idempotencyKey is required (min 8 characters)");
  }

  if (!input.cartToken || input.cartToken.trim().length < 8) {
    errors.push("cartToken is required");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}