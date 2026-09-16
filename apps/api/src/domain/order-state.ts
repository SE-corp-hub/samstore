// Order state machine — pure transition rules, unit-testable.
// Role-based: manual transitions require a reason; COD payment collected on delivery.

export const ORDER_STATES = [
  "RECEIVED",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "ON_HOLD",
  "COMPLETED",
  "CANCELLED",
  "FAILED_DELIVERY",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

// Allowed transitions (forward only; no skipping payment/delivery invariants).
export const ALLOWED_TRANSITIONS: Record<OrderState, OrderState[]> = {
  RECEIVED: ["CONFIRMED", "COMPLETED", "CANCELLED", "ON_HOLD"],
  CONFIRMED: ["PREPARING", "READY", "CANCELLED"], // READY = ready for pickup (pickup orders)
  PREPARING: ["READY", "CANCELLED"],
  READY: ["OUT_FOR_DELIVERY", "COMPLETED", "CANCELLED"], // delivery: send out; pickup: hand over at counter
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED_DELIVERY"],
  DELIVERED: [],
  ON_HOLD: ["COMPLETED", "CANCELLED"], // POS held — complete or void
  COMPLETED: [], // terminal POS/counter state
  CANCELLED: [],
  FAILED_DELIVERY: ["OUT_FOR_DELIVERY"], // retry delivery
};

/** States that are terminal — no transitions out. */
export function isTerminal(state: OrderState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

/** States that need an operator reason (manual overrides / cancellations). */
export function requiresReason(to: OrderState): boolean {
  return to === "CANCELLED" || to === "FAILED_DELIVERY";
}

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  if (!ORDER_STATES.includes(from) || !ORDER_STATES.includes(to)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderState, to: OrderState, reason?: string): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(`Cannot transition from ${from} to ${to}`);
  }
  if (requiresReason(to) && (!reason || reason.trim().length < 3)) {
    throw new InvalidTransitionError(`A reason (min 3 chars) is required for ${to}`);
  }
}

/** Payment status side-effect for COD: collecting on delivery. */
export function paymentEffectFor(to: OrderState, currentPayment: string): string {
  if (to === "DELIVERED" || to === "COMPLETED") return "COLLECTED";
  if (to === "CANCELLED" || to === "FAILED_DELIVERY") return "CANCELLED_REFUND";
  return currentPayment;
}