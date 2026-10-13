// Deterministic companion to perf-probe.mjs: counts the SQL statements ONE request causes,
// by diffing pg_stat_statements totals around it. Wall-clock on the managed pooler swings
// 2-3x run to run; statement count does not, so it is the metric that decides keep/revert
// for the round-trip-reduction work in PERF.md.
//
//   node --env-file=.env scripts/perf-queries.mjs
//
// Background traffic (an outbox poller, other sessions) adds a small constant; treat the
// reported number as "statements attributable to this request, ± noise".

import { PrismaClient } from "@prisma/client";

const API = process.env.PERF_API ?? "http://localhost:4100";
const prisma = new PrismaClient();

const totalCalls = async () => {
  const rows = await prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(calls), 0)::bigint AS n FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%'`);
  return Number(rows[0].n);
};

const login = await fetch(`${API}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.PERF_EMAIL ?? "admin@samstore.test", password: process.env.PERF_PASSWORD ?? "admin-pass-123" }),
}).then((r) => r.json());
const mine = await fetch(`${API}/admin/stores/mine`, { headers: { Authorization: `Bearer ${login.token}` } }).then((r) => r.json());
const headers = { Authorization: `Bearer ${login.token}`, "X-Store-Id": mine.stores[0].id };

// Per-query breakdown for ONE request: stable key = the normalised query text.
const snapshot = async () => {
  const rows = await prisma.$queryRawUnsafe(`SELECT md5(regexp_replace(query, '\\s+', ' ', 'g')) AS k, left(regexp_replace(query, '\\s+', ' ', 'g'), 60) AS q, calls::int AS n FROM pg_stat_statements`);
  return new Map(rows.map((r) => [r.k, { q: r.q, n: r.n }]));
};

for (const path of process.env.PERF_PATHS ? process.env.PERF_PATHS.split(",") : ["/admin/orders", "/admin/settings", "/admin/credit/utang", "/admin/pos/preorders"]) {
  await new Promise((r) => setTimeout(r, 1200)); // let background traffic settle
  const before = await totalCalls();
  const snap = await snapshot();
  const started = Date.now();
  const res = await fetch(`${API}${path}`, { headers });
  await res.text();
  const ms = Date.now() - started;
  const after = await totalCalls();
  const snap2 = await snapshot();
  const rows = [];
  for (const [k, v] of snap2) {
    const prev = snap.get(k)?.n ?? 0;
    const d = v.n - prev;
    if (d > 0 && !/pg_stat_statements|DISCARD ALL|pgbouncer|pg_timezone|pg_is_in_recovery|base_types/.test(v.q)) rows.push(`${d}x ${v.q}`);
  }
  console.log(`QCOUNT ${path} status=${res.status} wall=${ms}ms statements~${after - before}`);
  for (const r of rows.slice(0, 10)) console.log(`   ${r}`);
}

await prisma.$disconnect();
