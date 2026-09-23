// P9: BIR exports — Sales Journal + Cash Receipts Journal (CSV) + e-invoice adapter
// (D-marked PENDING_CREDENTIALS). Data is live-only; VAT lines follow the frozen
// order VAT columns; discount (incl. statutory) already flows through totals.

import { prisma } from "../persistence/prisma-repositories.js";

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

export class BirService {
  /** BIR Sales Journal: fulfilled orders in a period (invoice-level rows). */
  async salesJournalCsv(storeId: string, from: Date, to: Date): Promise<string> {
    const orders = await prisma.order.findMany({
      where: { storeId, status: { in: ["COMPLETED", "DELIVERED"] }, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
    });
    const settings = await prisma.storeSettings.findUnique({ where: { storeId } });
    const rate = (settings?.vatRateBp ?? 1200) / 10000;
    const header = row(["Date", "Receipt No", "Customer", "TIN", "Gross Sales", "VATable Amount", "VAT", "Exempt Sales", "Discount"]);
    const lines = orders.map((o) => {
      const vatExempt = o.vatExemptMinor ?? 0;
      const discount = o.discountMinor ?? 0;
      const net = o.totalMinor - (o.deliveryFeeMinor ?? 0);
      const vatable = net - vatExempt;
      const vat = settings?.vatEnabled ? Math.round(vatable * rate) : 0;
      return row([
        o.createdAt.toISOString().slice(0, 10),
        o.orderNumber,
        o.customerName,
        settings?.tin ?? "",
        o.totalMinor / 100,
        (vatable - discount) / 100,
        vat / 100,
        vatExempt / 100,
        discount / 100,
      ]);
    });
    return [header, ...lines].join("\n");
  }

  /** BIR Cash Receipts Journal: cash received per payment. */
  async cashReceiptsJournalCsv(storeId: string, from: Date, to: Date): Promise<string> {
    const payments = await prisma.payment.findMany({
      where: { storeId, type: "payment", amountMinor: { gt: 0 }, receivedAt: { gte: from, lte: to } },
      orderBy: { receivedAt: "asc" },
      include: { order: { select: { orderNumber: true, customerName: true } } },
    });
    const header = row(["Date", "Receipt No", "Customer", "Received", "Change"]);
    const lines = payments.map((p) => row([p.receivedAt.toISOString().slice(0, 10), p.order?.orderNumber ?? p.id, p.order?.customerName ?? "", p.amountMinor / 100, (p.changeMinor ?? 0) / 100]));
    return [header, ...lines].join("\n");
  }
}

/** e-invoice / CSF adapter — D-marked PENDING_CREDENTIALS (honest, never fake "submitted"). */
export interface EInvoiceAdapter {
  readonly name: string;
  ready(): boolean;
  /** Submit an invoice to the BIR CSF. Throws UnavailableError when not ready. */
  submitInvoice(input: { storeId: string; orderNumber: string; totalMinor: number; tin?: string | null; customerName?: string }): Promise<{ reference: string }>;
}

export class EInvoiceUnavailableError extends Error {
  constructor(message = "e-invoicing is PENDING_CREDENTIALS — configure BIR CSF credentials to enable") {
    super(message);
    this.name = "EInvoiceUnavailableError";
  }
}

export class PendingEInvoiceAdapter implements EInvoiceAdapter {
  readonly name = "pending";
  ready(): boolean {
    return typeof process.env.BIR_CSF_CREDENTIALS === "string" && process.env.BIR_CSF_CREDENTIALS.length > 0;
  }
  async submitInvoice(): Promise<{ reference: string }> {
    throw new EInvoiceUnavailableError();
  }
}