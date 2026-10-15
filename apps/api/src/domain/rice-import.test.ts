// Rice Ops M12 — reading the owner's go-live lists (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseCustomers, parseKargadors, parseProducts, parseStaff, pesoToMinor, signoffHtml } from "./rice-import.js";

const CODES = ["S1", "S2", "S3", "WH"];

test("M12 import: CSV from Excel — BOM, CRLF, quoted commas and quotes", () => {
  const rows = parseCsv('﻿name,note\r\n"Dela Cruz, Juan","sabi ""bukas"""\r\n\r\nAna,\r\n');
  assert.deepEqual(rows, [["name", "note"], ["Dela Cruz, Juan", 'sabi "bukas"'], ["Ana", ""]]);
  assert.throws(() => parseCsv('a\n"open'), /never closed/);
});

test("M12 import: peso amounts become centavos exactly; anything else is refused", () => {
  assert.equal(pesoToMinor("1,250"), 125_000);
  assert.equal(pesoToMinor("₱1,250.5"), 125_050);
  assert.equal(pesoToMinor("P 48.75"), 4_875);
  assert.equal(pesoToMinor(""), null);
  for (const bad of ["-5", "12.345", "abc", "1.2.3"]) assert.throws(() => pesoToMinor(bad), /not a peso amount/);
});

test("M12 import: products — sack weight, per-location prices, and every bad row named", () => {
  const csv = [
    "SKU,Name,Variety,Sold As,kg per sack,Cost,Price,price_S1,price_S2,price_WH",
    "sin-25,Sinandomeng 25 kg,Sinandomeng,sack,25,\"1,180\",\"1,300\",,\"1,320\",\"1,250\"",
    "SIN-K,Sinandomeng (kilo),Sinandomeng,KILO,,48,54,,,",
    "SUKA,Suka 1L,,PIECE,,20,35,,,",
    "BAD 1,X,,SACK,,1,2,,,",
    "DUP,Sinandomeng 25 kg,,SACK,1.1,1,2,,,",
  ].join("\n");
  const p = parseProducts(csv, CODES);
  assert.equal(p.rows.length, 4);
  const sack = p.rows[0]!;
  assert.equal(sack.sku, "SIN-25");
  assert.equal(sack.gramsPerSack, 25_000);
  assert.equal(sack.priceMinor, 130_000);
  assert.deepEqual(sack.locationPrices, { S2: 132_000, WH: 125_000 }, "blank = main price");
  assert.equal(p.rows[3]!.gramsPerSack, 1_100, "1.1 kg is 1,100 g exactly");
  const msgs = p.errors.map((e) => `${e.row}: ${e.message}`);
  assert.ok(msgs.some((m) => m.startsWith("5: SKU")), msgs.join(" | "));
  assert.ok(msgs.some((m) => m.startsWith("6: Same name as row 2")), msgs.join(" | "));
  assert.deepEqual(parseProducts("sku,name\nA,B", CODES).errors[0]?.message, "Missing column(s): sold_as, price");
});

test("M12 import: customers — mobile numbers, current utang needs a start date, no duplicates", () => {
  const csv = [
    "name,phone,limit,utang,utang_since,note",
    "Aling Rosa,0917 123 4567,\"5,000\",\"1,250.50\",2026-09-01,",
    "Mang Tomas,09181234567,,,,",
    "Walang petsa,09191234567,1000,500,,",
    "Bukas pa,09201234567,1000,500,2999-01-01,",
    "Ulit si Rosa,+639171234567,,,,",
    "Sira,12345,,,,",
  ].join("\n");
  const c = parseCustomers(csv, "2026-10-15");
  assert.equal(c.rows[0]!.phone, "+639171234567");
  assert.equal(c.rows[0]!.utangMinor, 125_050);
  assert.equal(c.rows[1]!.limitMinor, 0);
  assert.equal(c.rows[1]!.utangSince, null);
  const byRow = new Map(c.errors.map((e) => [e.row, e.message]));
  assert.match(byRow.get(4) ?? "", /utang_since/);
  assert.match(byRow.get(5) ?? "", /future/);
  assert.match(byRow.get(6) ?? "", /Same phone as row 2/);
  assert.match(byRow.get(7) ?? "", /PH mobile/);
});

test("M12 import: staff — roles, home location, PINs (leading zero kept), kargadors", () => {
  const s = parseStaff([
    "name,phone,role,home,pin",
    "Ate Lorna,09171112222,staff,s2,0482",
    "Kuya Jun,09171113333,Manager,,",
    "Agent Mike,09171114444,sales agent,S9,",
    "Si Owner,09171115555,OWNER,,",
    "Madali,09171116666,STAFF,S1,1234",
    "Excel,09171117777,STAFF,S1,482",
  ].join("\n"), CODES);
  assert.equal(s.rows[0]!.role, "STAFF");
  assert.equal(s.rows[0]!.home, "S2");
  assert.equal(s.rows[0]!.pin, "0482");
  assert.equal(s.rows[1]!.home, null, "a manager covers every location");
  assert.equal(s.rows.find((r) => r.name === "Excel")?.pin, "0482", "Excel dropped the leading zero; it is put back");
  const byRow = new Map(s.errors.map((e) => [e.row, e.message]));
  assert.match(byRow.get(4) ?? "", /Unknown location/);
  assert.match(byRow.get(5) ?? "", /owner is not imported/);
  assert.match(byRow.get(6) ?? "", /pin:/);

  const k = parseKargadors("name,phone,home,photo_url\nBoy,,WH,\nBoy ,,,\nEmong,0917,S1,\nNonoy,,S1,http://x.test/a.jpg", CODES);
  assert.equal(k.rows[0]!.home, "WH");
  assert.deepEqual(k.errors.map((e) => e.row).sort(), [3, 4, 5]);
});

test("M12 import: the sign-off sheet shows what was typed as text, with the utang total", () => {
  const html = signoffHtml({
    storeName: "Bigasan <Nena>", generatedAt: "2026-10-15 09:00",
    locations: [{ code: "S1", name: "Store 1" }],
    products: [{ sku: "A", name: "<script>x</script>", soldAs: "SACK", priceMinor: 130_000, costMinor: 0, locationPrices: { S1: 131_000 } }],
    customers: [{ name: "Rosa", phone: "+639171234567", limitMinor: 500_000, utangMinor: 125_050, utangSince: "2026-09-01" }, { name: "Tomas", phone: "+639181234567", limitMinor: 0, utangMinor: 74_950, utangSince: "2026-10-01" }],
    staffCount: 3, kargadorCount: 2,
  });
  assert.ok(!html.includes("<script>x"), "typed text is escaped");
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(html.includes("Bigasan &lt;Nena&gt;"));
  assert.ok(html.includes("₱2,000.00"), "utang total 1,250.50 + 749.50");
  assert.ok(html.includes("₱1,310.00"), "per-location price shown");
});
