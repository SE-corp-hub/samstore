// Repeatable performance probe — the "same command, same conditions" measurement for
// every optimization in PERF.md. Times a fixed set of endpoints N times each against a
// running API and prints the median, so a change is kept only if it beats run-to-run noise.
//
//   node scripts/perf-probe.mjs                 # defaults to the seeded demo owner
//   PERF_RUNS=5 node scripts/perf-probe.mjs
//
// Store-scoped endpoints are probed with the caller's first membership as X-Store-Id.

const API = process.env.PERF_API ?? "http://localhost:4100";
const EMAIL = process.env.PERF_EMAIL ?? "admin@samstore.test";
const PASSWORD = process.env.PERF_PASSWORD ?? "admin-pass-123";
const RUNS = Number(process.env.PERF_RUNS ?? 3);

const PATHS = [
  "/health/ready",
  "/admin/settings",
  "/admin/orders",
  "/admin/orders/counts",
  "/admin/analytics/status",
  "/admin/inventory?status=low",
  "/admin/pos/preorders",
  "/admin/credit/utang",
  "/admin/maintenance/stats",
];

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const login = await fetch(`${API}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then((r) => r.json());
if (!login?.token) {
  console.error("PERF probe: login failed — is the API running and seeded?");
  process.exit(1);
}
const mine = await fetch(`${API}/admin/stores/mine`, { headers: { Authorization: `Bearer ${login.token}` } }).then((r) => r.json());
const storeId = mine?.stores?.[0]?.id;
const headers = { Authorization: `Bearer ${login.token}`, ...(storeId ? { "X-Store-Id": storeId } : {}) };

let total = 0;
for (const path of PATHS) {
  const times = [];
  let status = 0;
  for (let i = 0; i < RUNS; i++) {
    const started = Date.now();
    try {
      const res = await fetch(`${API}${path}`, { headers });
      status = res.status;
      await res.text();
    } catch {
      status = -1;
    }
    times.push(Date.now() - started);
  }
  const m = median(times);
  total += m;
  console.log(`PERF ${path.padEnd(34)} status=${status} median=${m}ms runs=[${times.join(",")}]`);
}
console.log(`PERF TOTAL_median_sum=${total}ms`);
