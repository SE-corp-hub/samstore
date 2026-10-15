// Rice Ops M10 — one answer per Idempotency-Key for signed steps.
//
// On weak signal the phone queues a step and sends it again later. If the first try DID
// reach the server (only the answer was lost), the retry must not do the step twice:
//   * no header            → the request runs as before (old clients keep working);
//   * first time           → an IN_PROGRESS row is claimed (unique key), the step runs,
//                            and its answer is stored (DONE);
//   * same key again, done → the stored answer is returned; nothing runs;
//   * same key, still busy → 409 "Pinoproseso pa" (the phone retries a moment later);
//   * the step failed      → the claim is released, so a retry can run it properly.
// The key is scoped to the user, the store and the route, and only its hash is stored.

import { CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor } from "@nestjs/common";
import { createHash } from "node:crypto";
import { from, lastValueFrom, Observable, throwError } from "rxjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma-repositories.js";

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function idempotencyHash(userId: string, storeId: string, route: string, key: string): string {
  return createHash("sha256").update(`sam-store:step:v1:${userId}:${storeId}:${route}:${key}`).digest("hex");
}

interface ReqLike {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  originalUrl?: string;
  params?: Record<string, string>;
  user?: { sub?: string };
}
interface ResLike { status?: (code: number) => unknown; statusCode?: number }

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<ReqLike>();
    const res = context.switchToHttp().getResponse<ResLike>();
    const header = req.headers?.["idempotency-key"];
    const raw = Array.isArray(header) ? header[0] : header;
    if (req.method !== "POST" || !raw) return next.handle();
    if (!KEY_RE.test(raw)) {
      return throwError(() => new HttpException({ type: "validation", errors: ["Idempotency-Key: 8–128 letters, digits, . _ : -"] }, HttpStatus.UNPROCESSABLE_ENTITY));
    }
    const userId = req.user?.sub;
    if (!userId) return next.handle(); // the auth guard has already refused anonymous calls
    const storeHeader = req.headers?.["x-store-id"];
    const storeId = (Array.isArray(storeHeader) ? storeHeader[0] : storeHeader) ?? "";
    // The concrete path (with ids) — the same key on a different document is a different step.
    const route = (req.originalUrl ?? req.route?.path ?? "").split("?")[0]!;
    const keyHash = idempotencyHash(userId, storeId, route, raw);
    return from(this.run(keyHash, userId, route, res, () => lastValueFrom(next.handle(), { defaultValue: undefined })));
  }

  private async run(keyHash: string, userId: string, route: string, res: ResLike, handle: () => Promise<unknown>): Promise<unknown> {
    try {
      await prisma.idempotencyRecord.create({ data: { keyHash, userId, route } });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      const prior = await prisma.idempotencyRecord.findUnique({ where: { keyHash } });
      if (prior?.status === "DONE") {
        if (prior.responseStatus && typeof res.status === "function") res.status(prior.responseStatus);
        return prior.responseBody;
      }
      throw new HttpException({ type: "conflict", message: "Pinoproseso pa ang hakbang na ito — sandali lang" }, HttpStatus.CONFLICT);
    }
    try {
      const body = await handle();
      await prisma.idempotencyRecord.update({
        where: { keyHash },
        data: {
          status: "DONE", responseStatus: res.statusCode ?? 201, completedAt: new Date(),
          responseBody: body === undefined || body === null ? Prisma.JsonNull : (JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue),
        },
      });
      return body;
    } catch (e) {
      // A refused or failed step did nothing: free the key so the retry can run it.
      await prisma.idempotencyRecord.delete({ where: { keyHash } }).catch(() => {});
      throw e;
    }
  }
}
