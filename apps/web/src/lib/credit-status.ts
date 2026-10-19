// How a customer's credit standing is shown everywhere (Credit, Customers, POS).
// The server decides the status (domain/utang.ts creditStatus); this only gives it words and a colour.

export type CreditStatusCode = "NO_CREDIT" | "NO_LIMIT" | "OK" | "NEAR_LIMIT" | "AT_LIMIT";

const WORDS: Record<CreditStatusCode, { label: string; cls: string }> = {
  NO_CREDIT: { label: "No credit", cls: "text-bg-secondary" },
  NO_LIMIT: { label: "No limit", cls: "text-bg-info" },
  OK: { label: "OK", cls: "text-bg-success" },
  NEAR_LIMIT: { label: "Near limit", cls: "text-bg-warning" },
  AT_LIMIT: { label: "At limit — pay first", cls: "text-bg-danger" },
};

export function creditStatusWords(status: string | null | undefined): { label: string; cls: string } {
  return WORDS[(status ?? "NO_CREDIT") as CreditStatusCode] ?? WORDS.NO_CREDIT;
}

/** "No limit", "₱2,000.00" or "none yet" — the limit as a short phrase. */
export function limitPhrase(c: { creditApproved?: boolean; unlimited?: boolean; limitMinor: number | null }, peso: (m: number) => string): string {
  if (c.unlimited || (c.creditApproved && c.limitMinor === null)) return "No limit";
  if (!c.creditApproved) return "No credit yet";
  return c.limitMinor === null ? "No limit" : peso(c.limitMinor);
}
