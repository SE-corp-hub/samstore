// Runs every signed-in request behind its wall (see wall.ts). Registered once for the whole app.

import { type CallHandler, type ExecutionContext, HttpException, Injectable, type NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import type { AuthPrincipal } from "./auth.guard.js";
import { resolveTenant } from "./tenant-context.js";
import { checkWall, runWithWall, wallFor, type Wall } from "./wall.js";

type Req_ = { user?: AuthPrincipal; headers: Record<string, string | string[] | undefined>; method: string; route?: { path?: string }; params?: Record<string, string> };

@Injectable()
export class WallInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest<Req_>();
    const path = req.route?.path ?? "";
    if (!req.user || !path.startsWith("/admin")) return next.handle();
    let wall: Wall | null = null;
    let storeId = "";
    try {
      const header = req.headers["x-store-id"];
      const ctx = await resolveTenant(req.user, typeof header === "string" ? header : undefined);
      storeId = ctx.storeId;
      wall = await wallFor(ctx.storeId, req.user.sub, ctx.role);
    } catch {
      // No store for this login: the route itself answers that (403), there is nothing to wall.
      return next.handle();
    }
    const verdict = await checkWall(wall, storeId, req.method, path, req.params ?? {});
    if (!verdict.ok) throw new HttpException({ type: verdict.status === 403 ? "forbidden" : "not_found", message: verdict.message }, verdict.status);
    // The handler runs when the stream is subscribed to: do that inside the wall so every query it makes sees it.
    return new Observable((subscriber) => runWithWall(wall, () => next.handle().subscribe(subscriber)));
  }
}
