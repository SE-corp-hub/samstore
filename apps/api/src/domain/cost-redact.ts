// Staff never see what rice costs or what it earns. This takes those fields out of anything
// that is about to leave the server for a role that is not owner/manager.
// It returns a copy: cached answers are shared, so they must never be changed in place.

const COST_KEYS = new Set(["costMinor", "unitCostMinor", "valueMinor", "totalValueMinor", "costValueMinor", "grossProfitMinor", "profitMinor"]);

export function redactCost<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactCost(v)) as unknown as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (COST_KEYS.has(k)) continue;
      out[k] = redactCost(v);
    }
    return out as T;
  }
  return value;
}

/** Owner and manager see cost; everyone else does not. */
export const seesCost = (role: string | undefined): boolean => role === "OWNER" || role === "MANAGER" || role === "PLATFORM_ADMIN" || role === "STORE_OWNER";
