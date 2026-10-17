// Rice Ops M10 — a signed step queued offline and sent twice happens once (real DB).
import "reflect-metadata";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { HttpException, type CallHandler, type ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of, defer } from "rxjs";
import { prisma } from "../persistence/prisma-repositories.js";
import { IdempotencyInterceptor } from "./idempotency.interceptor.js";

const users: string[] = [];
after(async () => {
  await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: users } } });
  await prisma.$disconnect();
});

function ctx(userId: string, key: string | undefined, url = "/admin/resacks") {
  const req = { method: "POST", headers: { ...(key ? { "idempotency-key": key } : {}), "x-store-id": "store-test" }, originalUrl: url, user: { sub: userId } };
  const res = { statusCode: 201, status(c: number) { this.statusCode = c; return this; } };
  return { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext;
}
const user = () => { const u = `m10-${randomBytes(6).toString("hex")}`; users.push(u); return u; };
const key = () => `step-${randomBytes(8).toString("hex")}`;

test("M10: the same key twice runs the step once and returns the first answer", async () => {
  const i = new IdempotencyInterceptor();
  const u = user();
  const k = key();
  let runs = 0;
  const handler: CallHandler = { handle: () => defer(async () => { runs++; return { docNumber: "RSK-000007", at: new Date("2026-10-15T01:00:00Z") }; }) };
  const a = await lastValueFrom(i.intercept(ctx(u, k), handler));
  const b = await lastValueFrom(i.intercept(ctx(u, k), handler));
  assert.equal(runs, 1);
  assert.deepEqual(b, { docNumber: "RSK-000007", at: "2026-10-15T01:00:00.000Z" }, "the stored answer");
  assert.equal((a as { docNumber: string }).docNumber, "RSK-000007");
  const stored = await prisma.idempotencyRecord.findMany({ where: { userId: u } });
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0]!.keyHash, k, "only a hash of the key is kept");
});

test("M10: a refused step frees its key; no header = no change; keys never cross users or documents", async () => {
  const i = new IdempotencyInterceptor();
  const u = user();
  const k = key();
  let runs = 0;
  const failing: CallHandler = { handle: () => defer(async () => { runs++; throw new HttpException({ type: "validation", errors: ["Kulang ang pirma"] }, 422); }) };
  await assert.rejects(lastValueFrom(i.intercept(ctx(u, k), failing)));
  const ok: CallHandler = { handle: () => defer(async () => { runs++; return { ok: true }; }) };
  assert.deepEqual(await lastValueFrom(i.intercept(ctx(u, k), ok)), { ok: true }, "the retry, now signed, runs");
  assert.equal(runs, 2);
  let plain = 0;
  const count: CallHandler = { handle: () => { plain++; return of({ n: plain }); } };
  await lastValueFrom(i.intercept(ctx(u, undefined), count));
  await lastValueFrom(i.intercept(ctx(u, undefined), count));
  assert.equal(plain, 2, "without a key, every call runs (old clients)");
  const other = user();
  let x = 0;
  const h: CallHandler = { handle: () => defer(async () => ({ n: ++x })) };
  await lastValueFrom(i.intercept(ctx(u, k, "/admin/resacks/abc/finish"), h));
  await lastValueFrom(i.intercept(ctx(other, k, "/admin/resacks/abc/finish"), h));
  await lastValueFrom(i.intercept(ctx(u, k, "/admin/resacks/xyz/finish"), h));
  assert.equal(x, 3);
  await assert.rejects(lastValueFrom(i.intercept(ctx(u, "bad key!"), h)), (e: unknown) => e instanceof HttpException && e.getStatus() === 422 && /Idempotency-Key/.test(JSON.stringify(e.getResponse())));
});

test("M10: two sends at once — the step runs once; the other is told to wait or gets the same answer", async () => {
  const i = new IdempotencyInterceptor();
  const u = user();
  const k = key();
  let runs = 0;
  const slow: CallHandler = { handle: () => defer(async () => { runs++; await new Promise((r) => setTimeout(r, 400)); return { ok: true }; }) };
  const results = await Promise.allSettled([lastValueFrom(i.intercept(ctx(u, k), slow)), lastValueFrom(i.intercept(ctx(u, k), slow))]);
  assert.equal(runs, 1, "never both");
  assert.ok(results.some((r) => r.status === "fulfilled"), "one of them ran");
  // Which the second one sees depends on timing (on a slow link the first may already be
  // done): either "Pinoproseso pa" (409) or the first one's stored answer — never a second run.
  for (const r of results) {
    if (r.status === "fulfilled") assert.deepEqual(r.value, { ok: true });
    else assert.match(JSON.stringify((r.reason as HttpException).getResponse()), /still being processed/);
  }
  assert.deepEqual(await lastValueFrom(i.intercept(ctx(u, k), slow)), { ok: true }, "afterwards the stored answer comes back");
  assert.equal(runs, 1);
});
