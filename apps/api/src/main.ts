// NestJS bootstrap — thin HTTP layer over the domain services.
// Module 2 edge hardening:
//  - production config validation (fail fast when secrets are missing/weak)
//  - request body size cap (signatures are base64 data-URLs — 5 MB is generous
//    but still bounds abuse; express default is 100 KB and would break them)
//  - basic security headers
//  - per-process rate limiting on the PUBLIC + auth surface
//  - graceful shutdown hooks

import "reflect-metadata";
import express, { type Request, type Response, type NextFunction } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { rateLimitOk, clientKey } from "./security/rate-limit.js";
import { InsufficientStockFilter } from "./security/domain-exception.filter.js";
import { claimSecret, corsOriginCheck, corsOrigins, jwtSecret, missingSecrets, SecretConfigError } from "./security/secrets.js";
import { logRequest, recordRequest, sanitizeRequestId } from "./security/observability.js";

const PORT = Number(process.env.PORT ?? 4000);
const NODE_ENV = (process.env.NODE_ENV ?? "development").toLowerCase();

function fail(msg: string): never {
  console.error(`[sam-store] CONFIG ERROR: ${msg}`);
  process.exit(1);
}

// ── Config validation (Rice Ops M11: no committed secret fallbacks) ──────────
let allowedOrigins: string[] = [];
try {
  jwtSecret();
  claimSecret();
  allowedOrigins = corsOrigins();
} catch (e) {
  if (e instanceof SecretConfigError) fail(e.message);
  throw e;
}
if (NODE_ENV === "production") {
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is required in production");
} else {
  for (const name of missingSecrets()) {
    console.warn(`[sam-store] WARNING: ${name} is not set — using a random one for this run only (logins and claim links reset when the API restarts). Put ${name} in .env.`);
  }
  console.log("[sam-store] DEVELOPMENT MODE");
}

async function bootstrap() {
  // bodyParser: false → we install our own parser with an explicit size cap.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  // Domain errors decided by guarded DB writes → clean conflict responses.
  app.useGlobalFilters(new InsufficientStockFilter());

  // M9: drain the transactional outbox (notifications etc.) every few seconds.
  if (process.env.OUTBOX_WORKER_EMBEDDED !== "false") {
    const { OutboxWorker } = await import("./notifications/outbox.service.js");
    const outbox = new OutboxWorker();
    outbox.start(5_000);
    // Rice Ops M6: utang reminder texts, hourly (idempotent per customer per period).
    const { startUtangReminders } = await import("./utang/reminders.js");
    const stopReminders = startUtangReminders();
    app.getHttpAdapter().getInstance().on?.("close", () => { outbox.stop(); stopReminders(); });
  }

  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true, limit: "5mb" }));

  // P11b: dependency-free Swagger UI backed by the checked-in OpenAPI contract.
  // Production requires an explicit opt-in so the API surface is not exposed by
  // accident; the contract itself remains in docs/openapi.yaml for CI/review.
  const docsEnabled = NODE_ENV !== "production" || process.env.API_DOCS_ENABLED === "true";
  if (docsEnabled) {
    const http = app.getHttpAdapter().getInstance();
    http.get("/docs/openapi.yaml", async (_req: Request, res: Response) => {
      try {
        const candidates = [
          path.resolve(process.cwd(), "docs/openapi.yaml"),
          path.resolve(process.cwd(), "../../docs/openapi.yaml"),
        ];
        let body: string | null = null;
        for (const file of candidates) {
          try { body = await readFile(file, "utf8"); break; } catch { /* try next location */ }
        }
        if (body === null) { res.status(404).type("text").send("OpenAPI contract not found"); return; }
        res.type("text/yaml").send(body);
      } catch {
        res.status(500).type("text").send("OpenAPI contract unavailable");
      }
    });
    http.get("/docs/openapi-route-inventory.yaml", async (_req: Request, res: Response) => {
      try {
        const candidates = [
          path.resolve(process.cwd(), "docs/openapi-route-inventory.yaml"),
          path.resolve(process.cwd(), "../../docs/openapi-route-inventory.yaml"),
        ];
        let body: string | null = null;
        for (const file of candidates) {
          try { body = await readFile(file, "utf8"); break; } catch { /* try next location */ }
        }
        if (body === null) { res.status(404).type("text").send("OpenAPI route inventory not found"); return; }
        res.type("text/yaml").send(body);
      } catch {
        res.status(500).type("text").send("OpenAPI route inventory unavailable");
      }
    });
    http.get("/docs", (_req: Request, res: Response) => {
      res.type("html").send(`<!doctype html><html><head><title>PINDIAN API Docs</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script><script>window.ui=SwaggerUIBundle({url:'/docs/openapi.yaml',dom_id:'#swagger-ui'});</script></body></html>`);
    });
  }

  // Observability: request id (echoed back) + one structured REDACTED log line per
  // request. `req.path` excludes the query string on purpose — public links carry
  // their access token there and it must never reach the logs.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers["x-request-id"];
    const requestId = sanitizeRequestId(Array.isArray(incoming) ? incoming[0] : incoming);
    (req as Request & { id?: string }).id = requestId;
    res.setHeader("X-Request-Id", requestId);
    const start = Date.now();
    res.on("finish", () => {
      recordRequest(res.statusCode);
      logRequest({
        requestId,
        method: req.method,
        path: (req as Request & { path?: string }).path ?? req.url?.split("?")[0] ?? "/",
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  // Basic security headers (no external dependency).
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-XSS-Protection", "0"); // modern browsers: rely on CSP, disable legacy filter
    next();
  });

  // Rate limiting — PUBLIC + auth surface only (admin routes untouched: staff
  // panels do many legitimate calls; auth is their own bracket).
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const path = req.url ?? (req as { originalUrl?: string }).originalUrl ?? "";
    const isPublic =
      path.startsWith("/public/") ||
      path.startsWith("/cart") ||
      path.startsWith("/checkout") ||
      path.startsWith("/auth/");
    if (isPublic) {
      const xff = req.headers["x-forwarded-for"];
      const ip = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() ?? req.ip ?? "unknown";
      const burstKey = clientKey(ip, path.split("?")[0]);
      const authKey = clientKey(ip);
      const ok =
        (await rateLimitOk(burstKey, { limit: 120, windowMs: 60_000, prefix: "pub" })) &&
        (await rateLimitOk(authKey, { limit: 240, windowMs: 60_000, prefix: "ip" }));
      if (!ok) {
        res.status(429).json({ type: "rate_limited", message: "Too many requests — slow down and try again shortly." });
        return;
      }
    }
    next();
  });

  // Rice Ops M11: only the web app's own address may call the API from a browser.
  app.enableCors({
    origin: corsOriginCheck(allowedOrigins),
    credentials: false,
  });
  await app.listen(PORT);
  console.log(`[sam-store] API listening on http://localhost:${PORT}`);
}

void bootstrap();
