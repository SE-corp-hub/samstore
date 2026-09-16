import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { JwtAuthGuard, type AuthPrincipal } from "../auth/auth.guard.js";
import { resolveTenant, TENANT_ROLES } from "../auth/tenant-context.js";
import { REGISTER_SERVICE, RegisterService } from "./register.service.js";
import { assertDto, CASH_MOVEMENT_DTO, CLOSE_SHIFT_DTO, OPEN_SHIFT_DTO } from "../security/validate.js";

function statusFor(error: ApiError | { type: string; message: string }): HttpStatus {
  switch (error.type) {
    case "validation": return HttpStatus.UNPROCESSABLE_ENTITY;
    case "not_found": return HttpStatus.NOT_FOUND;
    case "conflict": return HttpStatus.CONFLICT;
    case "forbidden": return HttpStatus.FORBIDDEN;
    case "unauthorized": return HttpStatus.UNAUTHORIZED;
    default: return HttpStatus.BAD_REQUEST;
  }
}

/**
 * N1 — cash drawer / shifts. Admin-guarded, tenant-scoped via membership + X-Store-Id.
 * `register.close` and cash movements are manager+ operations; reading the current
 * shift and X-report is open to any counter role.
 */
@Controller("admin")
@UseGuards(JwtAuthGuard)
export class RegisterController {
  constructor(@Inject(REGISTER_SERVICE) private readonly registers: RegisterService) {}

  private async guardStore(req: Request & { user?: AuthPrincipal }, headerStoreId: string | undefined, roles: readonly string[]) {
    const { storeId } = await resolveTenant(req.user, headerStoreId, roles as never);
    return storeId;
  }

  /** GET /admin/registers — the store's registers (one today) + the open shift. */
  @Get("registers")
  async list(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const storeId = await this.guardStore(req, headerStoreId, TENANT_ROLES.VIEW);
    const [register, current] = await Promise.all([this.registers.ensureRegister(storeId), this.registers.currentSession(storeId)]);
    return { storeId, register, current };
  }

  /** GET /admin/registers/current — the open shift with its live drawer totals. */
  @Get("registers/current")
  async current(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const storeId = await this.guardStore(req, headerStoreId, TENANT_ROLES.VIEW);
    const session = await this.registers.currentSession(storeId);
    return { storeId, session };
  }

  /** POST /admin/registers/open — start a shift (opening float). */
  @Post("registers/open")
  async open(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { openingFloatMinor?: number; notes?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
    const storeId = await this.guardStore(req, headerStoreId, TENANT_ROLES.ADMIN);
    const dto = assertDto<{ openingFloatMinor?: number; notes?: string }>(body ?? {}, OPEN_SHIFT_DTO);
    const result = await this.registers.openSession(storeId, user.sub, dto);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { storeId, session: result.value };
  }

  /** POST /admin/registers/movements — cash in / cash out (manager+). */
  @Post("registers/movements")
  async movement(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { type: string; amountMinor: number; reason?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
    const storeId = await this.guardStore(req, headerStoreId, TENANT_ROLES.ADMIN);
    const dto = assertDto<{ type: string; amountMinor: number; reason?: string }>(body, CASH_MOVEMENT_DTO);
    const result = await this.registers.addMovement(storeId, user.sub, dto);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { storeId, session: result.value };
  }

  /** POST /admin/registers/close — count the drawer, close the shift, store the variance. */
  @Post("registers/close")
  async close(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { countedMinor: number; notes?: string },
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const user = req.user;
    if (!user) throw new HttpException({ type: "unauthorized", message: "Not authenticated" }, HttpStatus.UNAUTHORIZED);
    const storeId = await this.guardStore(req, headerStoreId, TENANT_ROLES.ADMIN);
    const dto = assertDto<{ countedMinor: number; notes?: string }>(body, CLOSE_SHIFT_DTO);
    const result = await this.registers.closeSession(storeId, user.sub, dto);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { storeId, session: result.value };
  }

  /** GET /admin/registers/report?kind=x|z[&sessionId=] — X (open shift) or Z (closed) report. */
  @Get("registers/report")
  async report(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query("kind") kind?: string,
    @Query("sessionId") sessionId?: string,
    @Headers("x-store-id") headerStoreId?: string,
  ) {
    const storeId = await this.guardStore(req, headerStoreId, TENANT_ROLES.VIEW);
    const which = kind === "z" ? "z" : "x";
    const result = await this.registers.report(storeId, which, sessionId);
    if (!result.ok) throw new HttpException(result.error, statusFor(result.error));
    return { storeId, report: result.value };
  }

  /** GET /admin/registers/sessions — shift history for the register panel. */
  @Get("registers/sessions")
  async sessions(@Req() req: Request & { user?: AuthPrincipal }, @Headers("x-store-id") headerStoreId?: string) {
    const storeId = await this.guardStore(req, headerStoreId, TENANT_ROLES.VIEW);
    const sessions = await this.registers.listSessions(storeId);
    return { storeId, sessions };
  }

  /** GET /admin/registers/sessions/:id — one shift (with its live totals). */
  @Get("registers/sessions/:id")
  async session(@Req() req: Request & { user?: AuthPrincipal }, @Param("id") id: string, @Headers("x-store-id") headerStoreId?: string) {
    const storeId = await this.guardStore(req, headerStoreId, TENANT_ROLES.VIEW);
    const sessions = await this.registers.listSessions(storeId, 100);
    const found = sessions.find((s) => s.sessionId === id);
    if (!found) throw new HttpException({ type: "not_found", message: "Shift not found" }, HttpStatus.NOT_FOUND);
    return { storeId, session: found };
  }
}
