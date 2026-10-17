// Rice Ops M3 — the rules of a trip between locations, without the database.
//
//   RESTOCK (Lipat):         REQUESTED → APPROVED → IN_TRANSIT → COMPLETED
//                            (from a WAREHOUSE it is approved on request)
//   ORDER_RELEASE (sale from
//   another location):       APPROVED → IN_TRANSIT → COMPLETED
//                                                 ↘ RETURNING → COMPLETED
//   CANCELLED only before anything left the source.
//
// Quantities only ever shrink along the trip: released ≤ requested, received or
// delivered ≤ released, returned ≤ what did not reach the customer. What goes
// missing on the road is the trip's short (Kulang sa lipat) and goes to the owner.

export type TransferStatusName = "REQUESTED" | "APPROVED" | "IN_TRANSIT" | "COMPLETED" | "CANCELLED" | "RETURNING";
export type TransferKindName = "RESTOCK" | "ORDER_RELEASE";

export type QtyCheck = { ok: true } | { ok: false; error: string };

const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** A request from a warehouse needs no approval (operator decision: auto-approve, with the trail). */
export function autoApproves(fromLocationType: string): boolean {
  return fromLocationType === "WAREHOUSE";
}

/** Ilabas: count out between 1 and what was asked for. */
export function checkRelease(requested: number, released: unknown): QtyCheck {
  if (!whole(released) || released < 1) return { ok: false, error: "Enter how many to release (1 or more)" };
  if (released > requested) return { ok: false, error: `Only ${requested} were requested` };
  return { ok: true };
}

/** Tanggapin (restock) or Naihatid (sale): between 0 and what left the source. */
export function checkArrival(released: number, counted: unknown): QtyCheck {
  if (!whole(counted) || counted < 0) return { ok: false, error: "Enter how many arrived (0 or more)" };
  if (counted > released) return { ok: false, error: `Only ${released} were released — it cannot be more than that` };
  return { ok: true };
}

/** Tanggapin pabalik: between 0 and what did not reach the customer. */
export function checkReturnBack(pending: number, counted: unknown): QtyCheck {
  if (!whole(counted) || counted < 0) return { ok: false, error: "Enter how many came back (0 or more)" };
  if (counted > pending) return { ok: false, error: `Only ${pending} should come back` };
  return { ok: true };
}

/** Restock arrival: what is short on the trip. */
export function receiveOutcome(released: number, received: number): { short: number } {
  return { short: released - received };
}

/** Sale delivery: everything not delivered must come back to the source. */
export function deliveryOutcome(released: number, delivered: number): { pendingReturn: number; nextStatus: "COMPLETED" | "RETURNING" } {
  const pendingReturn = released - delivered;
  return { pendingReturn, nextStatus: pendingReturn > 0 ? "RETURNING" : "COMPLETED" };
}

/** Return arrival: what is lost between the customer's door and the source. */
export function returnOutcome(pending: number, returned: number): { short: number } {
  return { short: pending - returned };
}

/** The sentence read back before signing (plain English, one line). */
export function readBack(
  step: "RELEASE" | "RECEIVE" | "DELIVERED" | "RETURN",
  t: { qty: number; product: string; from: string; to: string; kargador?: string | null; customer?: string | null },
): string {
  const dala = t.kargador ? `, carried by ${t.kargador}` : "";
  switch (step) {
    case "RELEASE":
      return `Release: ${t.qty} × ${t.product} from ${t.from}${dala}, for ${t.customer ? `customer (${t.customer})` : t.to}.`;
    case "RECEIVE":
      return `Receive at ${t.to}: ${t.qty} × ${t.product} from ${t.from}${dala}.`;
    case "DELIVERED":
      return `Delivered to ${t.customer ?? "customer"}: ${t.qty} × ${t.product}${dala}.`;
    case "RETURN":
      return `Returned to ${t.from}: ${t.qty} × ${t.product}${dala}.`;
  }
}
