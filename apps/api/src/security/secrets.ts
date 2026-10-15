// Rice Ops M11 — signing secrets without a committed fallback.
//
// Before M11, an unset JWT_SECRET silently fell back to a constant that is in this
// repository, so anyone with the source could forge an OWNER token. Now:
//  - production: the secret must be set, ≥ 32 characters, and not a placeholder —
//    otherwise the API refuses to start;
//  - development: an unset secret becomes a random one made when the API starts.
//    Nothing forgeable is in the repo; the only cost is that logins and claim links
//    stop working after a restart (set the secret in .env to keep them).

import { randomBytes } from "node:crypto";

export type SecretName = "JWT_SECRET" | "CLAIM_SIGNING_SECRET";

const PLACEHOLDERS = ["dev-", "change-me", "replace-with", "changeme", "placeholder"];
const generated = new Map<SecretName, string>();

export class SecretConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretConfigError";
  }
}

/** Why a configured secret is not good enough for production, or null when it is. */
export function weakSecretReason(value: string): string | null {
  if (value.length < 32) return "must be at least 32 characters";
  const lower = value.toLowerCase();
  const hit = PLACEHOLDERS.find((p) => lower.includes(p));
  return hit ? `still contains the placeholder text "${hit}"` : null;
}

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? "development").toLowerCase() === "production";
}

/** The secret to sign with. Throws (production only) when it is missing or weak. */
export function secretFrom(name: SecretName, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim() ?? "";
  if (isProduction(env)) {
    if (!value) throw new SecretConfigError(`${name} is required in production`);
    const weak = weakSecretReason(value);
    if (weak) throw new SecretConfigError(`${name} ${weak}`);
    return value;
  }
  if (value) return value;
  let made = generated.get(name);
  if (!made) {
    made = randomBytes(32).toString("hex");
    generated.set(name, made);
  }
  return made;
}

export const jwtSecret = (env: NodeJS.ProcessEnv = process.env) => secretFrom("JWT_SECRET", env);
export const claimSecret = (env: NodeJS.ProcessEnv = process.env) => secretFrom("CLAIM_SIGNING_SECRET", env);

/** Which secrets are unset (development warning at start-up). */
export function missingSecrets(env: NodeJS.ProcessEnv = process.env): SecretName[] {
  return (["JWT_SECRET", "CLAIM_SIGNING_SECRET"] as const).filter((n) => !env[n]?.trim());
}

// ── CORS ─────────────────────────────────────────────────────────────────────
// Before M11 the API answered every origin (origin: true). Now only the web app's
// own address(es) may call it from a browser: CORS_ORIGINS, comma-separated.

const DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

function cleanOrigin(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, "");
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The allowed browser origins. Production needs CORS_ORIGINS (https only); development adds localhost. */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = listed.filter((s) => !cleanOrigin(s));
  if (bad.length) throw new SecretConfigError(`CORS_ORIGINS has an invalid origin: ${bad.join(", ")}`);
  const origins = listed.map((s) => cleanOrigin(s)!);
  if (isProduction(env)) {
    if (origins.length === 0) throw new SecretConfigError("CORS_ORIGINS is required in production (the web app's address, e.g. https://tindahan.example.com)");
    const plain = origins.filter((o) => !o.startsWith("https://"));
    if (plain.length) throw new SecretConfigError(`CORS_ORIGINS must use https in production: ${plain.join(", ")}`);
    return [...new Set(origins)];
  }
  return [...new Set([...origins, ...DEV_ORIGINS])];
}

/** The cors `origin` callback: requests with no Origin (curl, server-to-server) pass; browsers must be listed. */
export function corsOriginCheck(allowed: string[]) {
  const set = new Set(allowed);
  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    cb(null, set.has(origin));
  };
}
