// Who can change what: try every change in the table as each kind of login at each place, against a
// RUNNING API, and say where the server and the table (apps/web/src/lib/who-can.ts) disagree.
//
//   npx tsx scripts/who-can-check.ts --store test-bigasan [--api http://localhost:4100]
//
// TEST DATABASES ONLY: it adds logins named who-* to the store (password in WHO_CAN_PASSWORD or a fixed
// test one) and writes each setting back with the value it already has, so nothing changes.
// Yes / own = the server must let it through (2xx, or 400 for a body it does not like).
// look / no = the server must refuse it (403).

import bcrypt from "bcryptjs";
import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";
import { RULES, rightOf, type Who } from "../apps/web/src/lib/who-can.js";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] ?? d : d; };
const API = arg("--api", "http://localhost:4100");
const SLUG = arg("--store", "test-bigasan");
const PASSWORD = process.env.WHO_CAN_PASSWORD ?? "WhoCan-test-2026";

type Login = { who: Who; label: string; home: string | null; token: string };
type Probe = { rule: string; at?: string; method: string; path: string; body?: unknown };

async function main() {
  const store = await prisma.store.findUniqueOrThrow({ where: { slug: SLUG }, select: { id: true } });
  const storeId = store.id;
  const places = await prisma.warehouse.findMany({ where: { storeId, isActive: true }, orderBy: { code: "asc" }, select: { id: true, name: true, code: true, type: true } });
  const owner = await prisma.userStore.findFirstOrThrow({ where: { storeId, role: "OWNER" }, select: { userId: true } });
  const hash = await bcrypt.hash(PASSWORD, 10);

  // ── the logins: owner, a manager, then a head and a counter login at every place ──
  const want: { key: string; role: "MANAGER" | "STAFF"; home: string | null; head: boolean; who: Who; label: string }[] = [
    { key: "manager", role: "MANAGER", home: null, head: false, who: "manager", label: "Manager" },
    ...places.flatMap((p) => [
      { key: `head-${p.code ?? p.id}`, role: "STAFF" as const, home: p.id, head: true, who: "head" as Who, label: `Head of ${p.name}` },
      { key: `staff-${p.code ?? p.id}`, role: "STAFF" as const, home: p.id, head: false, who: "staff" as Who, label: `Counter at ${p.name}` },
    ]),
  ];
  const ownerUser = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId }, select: { email: true } });
  await prisma.user.update({ where: { id: owner.userId }, data: { passwordHash: hash, mustChangePassword: false, loginFailedCount: 0, loginLockedUntil: null } });
  const logins: Login[] = [{ who: "owner", label: "Owner", home: null, token: await login(ownerUser.email!) }];
  for (const w of want) {
    const email = `who-${w.key}@${SLUG}.test`.toLowerCase();
    const u = await prisma.user.upsert({ where: { email }, update: { passwordHash: hash, mustChangePassword: false, loginFailedCount: 0, loginLockedUntil: null }, create: { email, name: `Who ${w.label}`, passwordHash: hash, role: w.role } });
    await prisma.userStore.upsert({
      where: { userId_storeId: { userId: u.id, storeId } },
      update: { role: w.role, homeLocationId: w.home, isLocationHead: w.head, status: "ACTIVE" },
      create: { userId: u.id, storeId, role: w.role, homeLocationId: w.home, isLocationHead: w.head, status: "ACTIVE" },
    });
    logins.push({ who: w.who, label: w.label, home: w.home, token: await login(email) });
  }

  // ── what to try: the value it already has goes back in ──
  const settings = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { name: true, settings: { select: { seniorPwdDiscountEnabled: true, creditTermDays: true, quotaPromoEnabled: true, allowGuestOrders: true } } } });
  const product = await prisma.product.findFirstOrThrow({ where: { storeId, isActive: true }, select: { id: true, name: true, priceMinor: true, floorPriceMinor: true } });
  const sells = places.filter((p) => p.type !== "WAREHOUSE");
  const probes: Probe[] = [
    { rule: "businessName", method: "PATCH", path: "/admin/store-name", body: { name: settings.name } },
    { rule: "vat", method: "PATCH", path: "/admin/settings", body: { seniorPwdDiscountEnabled: settings.settings?.seniorPwdDiscountEnabled ?? false } },
    { rule: "credit", method: "PATCH", path: "/admin/settings", body: { creditTermDays: settings.settings?.creditTermDays ?? 30 } },
    { rule: "quotaPromo", method: "PATCH", path: "/admin/settings", body: { quotaPromoEnabled: settings.settings?.quotaPromoEnabled ?? false } },
    { rule: "onlineShop", method: "PATCH", path: "/admin/settings", body: { allowGuestOrders: settings.settings?.allowGuestOrders ?? false } },
    ...places.map((p) => ({ rule: "locations", at: p.id, method: "PATCH", path: `/admin/warehouses/${p.id}`, body: { name: p.name } })),
    // An empty new product: allowed logins get 422 (name needed), refused ones 403. Nothing is saved.
    { rule: "productAdd", method: "POST", path: "/admin/products", body: {} },
    { rule: "productSetup", method: "PATCH", path: `/admin/products/${product.id}`, body: { name: product.name } },
    { rule: "productPrice", method: "PATCH", path: `/admin/products/${product.id}`, body: { priceMinor: product.priceMinor } },
    { rule: "lowestPrice", method: "PUT", path: `/admin/products/${product.id}/lowest-price`, body: { floorPriceMinor: product.floorPriceMinor } },
    ...places.map((p) => ({ rule: "thisStore", at: p.id, method: "PATCH", path: `/admin/store-settings/${p.id}`, body: {} })),
  ];
  for (const p of sells) {
    const own = await prisma.locationPrice.findFirst({ where: { warehouseId: p.id, productId: product.id }, select: { priceMinor: true } }).catch(() => null);
    probes.push({ rule: "storePrice", at: p.id, method: "PUT", path: `/admin/warehouses/${p.id}/prices/${product.id}`, body: { priceMinor: own?.priceMinor ?? null } });
  }

  // ── try them all ──
  const wrong: string[] = [];
  let tried = 0;
  for (const probe of probes) {
    for (const l of logins) {
      const right = rightOf(l.who, probe.rule);
      const expectYes = right === "yes" || (right === "own" && (!probe.at || probe.at === l.home));
      const res = await fetch(`${API}${probe.path}`, {
        method: probe.method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${l.token}`, "X-Store-Id": storeId },
        body: probe.body === undefined ? undefined : JSON.stringify(probe.body),
      });
      tried++;
      const gotYes = res.ok || res.status === 400 || res.status === 422; // 400/422: let in, but the (empty) change was refused as incomplete
      const place = probe.at ? ` at ${places.find((x) => x.id === probe.at)?.name}` : "";
      if (gotYes !== expectYes) {
        const msg = await res.text().catch(() => "");
        wrong.push(`${probe.rule}${place} as ${l.label}: table says ${expectYes ? "YES" : "NO"}, server said ${res.status} ${msg.slice(0, 120)}`);
      }
    }
  }
  console.log(`Tried ${tried} changes (${probes.length} kinds × ${logins.length} logins), ${RULES.length} rules in the table.`);
  if (wrong.length) { console.log(`${wrong.length} DISAGREE:\n- ${wrong.join("\n- ")}`); process.exitCode = 1; }
  else console.log("The server agrees with the table everywhere.");
  await prisma.$disconnect();

  async function login(identifier: string): Promise<string> {
    const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier, password: PASSWORD }) });
    const d = (await r.json()) as { token?: string; message?: string };
    if (!d.token) throw new Error(`login ${identifier}: ${r.status} ${d.message ?? ""}`);
    return d.token;
  }
}

void main();
