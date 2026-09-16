// Observability primitives (Module 11 gap): request ids, structured REDACTED logs
// and cheap in-process counters.
//
// Logging rule: never log query strings (public links carry the access token),
// never log bodies, signatures, phone numbers or addresses. Only method, PATH
// (no query), status, duration and the request id.

import { randomUUID } from "node:crypto";

export interface RequestCounters {
  total: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  conflicts: number;
  rateLimited: number;
}

const counters: RequestCounters = {
  total: 0,
  status2xx: 0,
  status3xx: 0,
  status4xx: 0,
  status5xx: 0,
  conflicts: 0,
  rateLimited: 0,
};

const startedAt = Date.now();

export function recordRequest(status: number): void {
  counters.total += 1;
  if (status >= 500) counters.status5xx += 1;
  else if (status >= 400) counters.status4xx += 1;
  else if (status >= 300) counters.status3xx += 1;
  else counters.status2xx += 1;
  if (status === 409) counters.conflicts += 1;
  if (status === 429) counters.rateLimited += 1;
}

export function metricsSnapshot() {
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    requests: { ...counters },
  };
}

/** Only accept a client-supplied request id when it is short and boring.
 *  Deliberately EXCLUDES '.' so a JWT or any dotted token cannot be echoed back
 *  into a response header / log line. */
export function sanitizeRequestId(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9_:-]{8,64}$/.test(value)) return value;
  return randomUUID();
}

function write(entry: Record<string, unknown>): void {
  // One JSON object per line — parseable by any log shipper, no secrets included.
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export function logRequest(entry: { requestId: string; method: string; path: string; status: number; durationMs: number }): void {
  const level = entry.status >= 500 ? "error" : entry.status >= 400 ? "warn" : "info";
  write({ ts: new Date().toISOString(), level, msg: "request", ...entry });
}

export function logEvent(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  write({ ts: new Date().toISOString(), level, msg, ...fields });
}

export function resetCountersForTest(): void {
  counters.total = 0;
  counters.status2xx = 0;
  counters.status3xx = 0;
  counters.status4xx = 0;
  counters.status5xx = 0;
  counters.conflicts = 0;
  counters.rateLimited = 0;
}
