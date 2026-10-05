-- Close the public data API on the `public` schema.
--
-- Why: every table here had RLS disabled AND the `anon` + `authenticated` roles
-- held SELECT/INSERT/UPDATE/DELETE on all of them (Supabase Shield flagged this as
-- rls_disabled_in_public + sensitive_columns_exposed). Anyone with the project's
-- public URL and anon key could read or destroy the whole database via PostgREST,
-- including User.passwordHash, Customer, Payment and OrderClaimToken.
--
-- Safe for the app: it reaches Postgres as `postgres`, which carries BYPASSRLS and
-- is the owner of every table, so RLS and the revoked grants never apply to it.
-- `service_role` also bypasses RLS. Only `anon`/`authenticated` lose access, which
-- is the point — this application never uses the Data API.

-- 1. Row-level security on every table in the public schema (idempotent).
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END
$$;

-- 2. Strip the public roles' grants on existing tables and sequences.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 3. Keep future tables created by later migrations locked down by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;