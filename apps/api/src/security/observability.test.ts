// Module 11 fix — observability: request ids, redaction and counters.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  logEvent,
  logRequest,
  metricsSnapshot,
  recordRequest,
  resetCountersForTest,
  sanitizeRequestId,
} from "./observability.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("sanitizeRequestId keeps boring ids and refuses anything token-like", () => {
  assert.equal(sanitizeRequestId("abc-12345678"), "abc-12345678");
  assert.equal(sanitizeRequestId("order_2026-09-13T01:00:00Z"), "order_2026-09-13T01:00:00Z");

  // A public-link token, a JWT, or anything with quotes/spaces must NOT be echoed back.
  const hostile = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc",
    "3f2b1c9d4e5f60718293a4b5c6d7e8f9.gSwCEsvx9NPF8uSo_18q2S3IjgmEp4KTzpT2VwSDChI",
    "short",
    "x".repeat(65),
    "../etc/passwd",
    "space id here",
    '{"injected":"header"}',
    undefined,
    null,
    42,
  ];
  for (const value of hostile) {
    const out = sanitizeRequestId(value);
    assert.match(out, UUID_RE, `expected a fresh UUID for ${String(value).slice(0, 20)}`);
  }
});

test("counters bucket by status class and flag conflicts/429s", () => {
  resetCountersForTest();
  for (const s of [200, 201, 204]) recordRequest(s);
  recordRequest(302);
  recordRequest(404);
  recordRequest(409);
  recordRequest(429);
  recordRequest(500);
  const m = metricsSnapshot();
  assert.equal(m.requests.total, 8);
  assert.equal(m.requests.status2xx, 3);
  assert.equal(m.requests.status3xx, 1);
  assert.equal(m.requests.status4xx, 3, "404 + 409 + 429 are all 4xx");
  assert.equal(m.requests.status5xx, 1);
  assert.equal(m.requests.conflicts, 1);
  assert.equal(m.requests.rateLimited, 1);
  assert.ok(m.uptimeSec >= 0);
});

test("logRequest/logEvent emit one JSON object per line with no extra fields", () => {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  try {
    logRequest({ requestId: "req-abcdefgh", method: "GET", path: "/public/stores/sam-store", status: 200, durationMs: 12 });
    logEvent("warn", "test_event", { detail: "ok" });
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }

  assert.equal(written.length, 2);
  const entries = written.map((w) => JSON.parse(w.trim()) as Record<string, unknown>);
  const first = entries[0]!;
  const second = entries[1]!;
  assert.equal(first.msg, "request");
  assert.equal(first.level, "info");
  assert.equal(first.path, "/public/stores/sam-store", "path is logged WITHOUT a query string");
  assert.equal(first.durationMs, 12);
  assert.equal(typeof first.ts, "string");
  assert.equal(second.msg, "test_event");
  assert.equal(second.level, "warn");
  assert.equal(second.detail, "ok");
});

test("a 5xx is logged at error level, a 4xx at warn", () => {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  try {
    logRequest({ requestId: "req-abcdefgh", method: "POST", path: "/public/checkout", status: 500, durationMs: 5 });
    logRequest({ requestId: "req-abcdefgh", method: "POST", path: "/public/checkout", status: 409, durationMs: 5 });
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  assert.equal((JSON.parse(written[0]!.trim()) as { level: string }).level, "error");
  assert.equal((JSON.parse(written[1]!.trim()) as { level: string }).level, "warn");
});
