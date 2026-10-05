// Guard for the public data API: the `public` schema must never be readable or
// writable through PostgREST. The app reaches Postgres as the `postgres` role,
// which carries BYPASSRLS, so RLS and the grants to `anon`/`authenticated` can only
// ever restrict the public API — they cannot lock out the application.
// Every new migration that adds a table is covered by the first test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./prisma-repositories.js";

const TABLES_WITHOUT_RLS = `
  SELECT c.relname AS name FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  ORDER BY 1`;

const EXPOSED_TO_PUBLIC_ROLES = `
  SELECT c.relname AS name FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND (
    has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('anon', c.oid, 'INSERT')
    OR has_table_privilege('anon', c.oid, 'UPDATE') OR has_table_privilege('anon', c.oid, 'DELETE')
    OR has_table_privilege('authenticated', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'INSERT')
    OR has_table_privilege('authenticated', c.oid, 'UPDATE') OR has_table_privilege('authenticated', c.oid, 'DELETE'))
  ORDER BY 1`;

test("every table in the public schema has row-level security enabled", async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(TABLES_WITHOUT_RLS);
  assert.deepEqual(rows.map((r) => r.name), [], "tables reachable without RLS");
});

test("anon and authenticated hold no privileges on public tables", async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(EXPOSED_TO_PUBLIC_ROLES);
  assert.deepEqual(rows.map((r) => r.name), [], "tables the public API can read or write");
});

test("the application role bypasses RLS, so the API keeps full access", async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ rolname: string; rolbypassrls: boolean }>>(
    `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('postgres', 'service_role') ORDER BY 1`,
  );
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.rolbypassrls, true, `${r.rolname} must bypass RLS`);
});