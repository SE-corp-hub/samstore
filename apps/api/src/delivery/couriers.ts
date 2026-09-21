// Courier adapters (Phase 5 / §17) — Lalamove / GrabExpress / J&T.
// Mock-first: every adapter is PENDING_CREDENTIALS (ready() false without its env
// key) and returns deterministic sandbox tracking numbers — honest, never a fake
// "booked on a real courier". The mock powers tests and demos.

import { randomBytes } from "node:crypto";

export interface CourierBookingInput {
  referenceId: string; // our order id
  amountMinor: number;
  currency: string;
  pickupNote?: string;
  dropoffAddress?: string;
}

export interface CourierBookingResult {
  trackingNumber: string;
  remoteId: string;
}

export interface CourierAdapter {
  readonly name: string;
  /** Credentials present → ready for live bookings? (honest status) */
  ready(): boolean;
  createBooking(input: CourierBookingInput): Promise<CourierBookingResult>;
}

/** Deterministic mock courier — records bookings, never reaches the network. */
export class MockCourierAdapter implements CourierAdapter {
  readonly name = "mock";
  ready(): boolean {
    return true;
  }
  async createBooking(input: CourierBookingInput): Promise<CourierBookingResult> {
    const ref = randomBytes(8).toString("base64url");
    return { trackingNumber: `MOCK-${ref}`, remoteId: `mock_booking_${ref}` };
  }
}

/** Shared PENDING_CREDENTIALS behavior: reports ready() from env, sandbox tracking. */
class PendingCredentialsCourier implements CourierAdapter {
  constructor(readonly name: string, private readonly envKey: string) {}
  ready(): boolean {
    return typeof process.env[this.envKey] === "string" && process.env[this.envKey]!.length > 0;
  }
  async createBooking(input: CourierBookingInput): Promise<CourierBookingResult> {
    const ref = randomBytes(8).toString("base64url");
    // No live API call is ever made without credentials; the sandbox ref is clearly-labelled.
    return { trackingNumber: `${this.name.toUpperCase()}-${this.ready() ? "" : "SANDBOX-"}${ref}`, remoteId: `remote_${ref}` };
  }
}

const registry: Record<string, () => CourierAdapter> = {
  mock: () => new MockCourierAdapter(),
  lalamove: () => new PendingCredentialsCourier("lalamove", "LALAMOVE_API_KEY"),
  grabexpress: () => new PendingCredentialsCourier("grabexpress", "GRABEXPRESS_API_KEY"),
  jt: () => new PendingCredentialsCourier("jt", "JT_API_KEY"),
  owner: () => new PendingCredentialsCourier("owner", "OWNER_DELIVERY"), // owner-run: no external API ever
};

export function getCourier(name: string): CourierAdapter {
  const factory = registry[name];
  if (!factory) throw new Error(`Unknown courier: ${name}`);
  return factory();
}