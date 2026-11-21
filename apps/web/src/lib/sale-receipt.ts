// The POS sales receipt: what a sale prints on the Bluetooth roll (or the print window), online or offline.
// Pure, so the layout is unit-tested.

import type { Slip, SlipLine } from "./slip-print";
import { peso, kg } from "./number-format";

/** One sale line on the receipt: "2 x ₱1,250.00" for sacks and pieces, "1.785 kg x ₱52.00/kg" for loose rice. */
export function receiptDetail(x: { soldBy: string | null; quantity: number; grams: number | null; unitPriceMinor?: number | null }): string {
  const grams = x.soldBy !== "PIECE" ? x.grams : null;
  const perKilo = !!grams;
  const qty = grams ? kg(grams) : `${x.quantity}`;
  if (x.unitPriceMinor == null) return qty;
  return `${qty} x ${peso(x.unitPriceMinor)}${perKilo ? "/kg" : ""}`;
}

/** The POS sales receipt (printed on the Bluetooth roll, or the print window offline too). */
export function saleReceipt(l: {
  status: string; offline?: boolean; customerName?: string | null; orderNumber: string; totalMinor: number; changeMinor: number;
  lines: { name: string; soldBy: string | null; quantity: number; grams: number | null; unitPriceMinor?: number | null; lineTotalMinor: number }[];
  payLabel?: string | null; tenderedMinor?: number | null;
}, storeName: string, locationId?: string | null, at: Date = new Date()): Slip {
  const totals: SlipLine[] = [{ label: "TOTAL", value: peso(l.totalMinor), strong: true }];
  if (l.payLabel) totals.push({ label: "Paid by", value: l.payLabel });
  if (l.tenderedMinor && l.tenderedMinor > 0) totals.push({ label: "Cash given", value: peso(l.tenderedMinor) });
  if (l.changeMinor > 0) totals.push({ label: "Change", value: peso(l.changeMinor) });
  return {
    storeName, locationId, title: "SALES RECEIPT", reference: l.orderNumber,
    when: at.toLocaleString("en-PH", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }),
    lines: [{ label: "Customer", value: l.customerName || "Walk-in" }],
    rows: l.lines.map((x) => ({ name: x.name, qty: "", detail: receiptDetail(x), amount: peso(x.lineTotalMinor) })),
    totals,
    footer: l.status === "WAITING_OWNER" ? "Waiting for owner approval" : l.offline ? "Saved offline · Salamat po!" : "Salamat po!",
  };
}
