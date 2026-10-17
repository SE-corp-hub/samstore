// Rice Ops M7 — pure rules for agent orders. No DB.
//
//   The agent's order waits (Naghihintay) until staff at the preferred store approve it
//   (Aprubado → the rice is held where it will come from) or decline it (Tinanggihan).
//   From there it is the M3 release flow: Ilabas → Naihatid → payment (cash or utang),
//   and the agent sees every step. Payment is taken AFTER delivery, for what was delivered.

import { refundValue } from "./utang.js";

export type AgentStatusCode = "NAGHIHINTAY" | "APRUBADO" | "NAILABAS" | "NAIHATID" | "BAYAD_NA" | "TINANGGIHAN" | "KINANSELA";

export const AGENT_STATUS_LABEL: Record<AgentStatusCode, string> = {
  NAGHIHINTAY: "Waiting",
  APRUBADO: "Approved",
  NAILABAS: "On the way",
  NAIHATID: "Delivered — waiting for payment",
  BAYAD_NA: "Paid",
  TINANGGIHAN: "Declined",
  KINANSELA: "Cancelled",
};

interface TripView { status: string; deliveredQty: number | null }

/** Where an agent order stands, from the order and its trips. */
export function agentStatus(order: { status: string; declineReason: string | null }, trips: TripView[]): AgentStatusCode {
  if (order.status === "CANCELLED") return order.declineReason ? "TINANGGIHAN" : "KINANSELA";
  if (order.status === "COMPLETED") return "BAYAD_NA";
  if (order.status === "RECEIVED") return "NAGHIHINTAY";
  const live = trips.filter((t) => t.status !== "CANCELLED");
  if (live.length > 0 && live.every((t) => t.deliveredQty !== null)) return "NAIHATID";
  if (live.some((t) => t.status === "IN_TRANSIT" || t.deliveredQty !== null)) return "NAILABAS";
  return "APRUBADO";
}

/** Every line of the order has been delivered (or its trip cancelled) — time to take the money. */
export function readyToPay(trips: TripView[]): boolean {
  return trips.length > 0 && trips.every((t) => t.status === "CANCELLED" || t.deliveredQty !== null);
}

/** What the customer owes: each line for what was actually delivered. */
export function amountDue(lines: { soldBy: string | null; unitPriceMinor: number; quantity: number; lineTotalMinor: number; delivered: number }[]): number {
  return lines.reduce((sum, l) => {
    if (l.delivered >= l.quantity) return sum + l.lineTotalMinor;
    return sum + (l.delivered > 0 ? refundValue(l, l.delivered) : 0);
  }, 0);
}

/** A delivery address the kargador can find. */
export function checkAddress(address: unknown): string {
  const a = typeof address === "string" ? address.trim().replace(/\s+/g, " ") : "";
  if (a.length < 5 || a.length > 200) throw new Error("Enter the address (barangay, street, landmark)");
  return a;
}
