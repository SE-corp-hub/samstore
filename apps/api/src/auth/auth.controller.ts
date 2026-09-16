import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  Post,
} from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { AuthService, AUTH_SERVICE } from "./auth.service.js";
import { assertDto, CHANGE_PASSWORD_DTO, LOGIN_DTO, REGISTER_DTO } from "../security/validate.js";

function statusFor(error: ApiError): HttpStatus {
  switch (error.type) {
    case "validation":
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case "not_found":
      return HttpStatus.NOT_FOUND;
    case "conflict":
      return HttpStatus.CONFLICT;
    case "forbidden":
      return HttpStatus.FORBIDDEN;
    case "unauthorized":
      return HttpStatus.UNAUTHORIZED;
    case "rate_limited":
      return HttpStatus.TOO_MANY_REQUESTS;
  }
}

@Controller("auth")
export class AuthController {
  constructor(@Inject(AUTH_SERVICE) private readonly auth: AuthService) {}

  /**
   * POST /auth/register — create a bare user account.
   * Module 1 (invite/admin-created owner only): storeId/role are NOT accepted.
   * The user is created with no store membership; a platform admin binds them as
   * a store owner via /admin/stores, or an existing owner invites them via /admin/team.
   */
  @Post("register")
  async register(
    @Body() body: { email?: string; phone?: string; password: string; name?: string },
  ) {
    // Module 2 fix: shape-validate the untrusted body (unknown keys rejected — a
    // client-supplied storeId/role is a 422, not a silently ignored extra field).
    const dto = assertDto<{ email?: string; phone?: string; password: string; name?: string }>(body, REGISTER_DTO);
    const r = await this.auth.register(dto);
    if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
    return r.value;
  }

  /** POST /auth/login — exchange credentials for a JWT. Identifier = phone or email. */
  @Post("login")
  async login(@Body() body: { identifier?: string; email?: string; password: string }) {
    const dto = assertDto<{ identifier?: string; email?: string; password: string }>(body, LOGIN_DTO);
    const identifier = dto.identifier?.trim() || dto.email?.trim() || "";
    const r = await this.auth.login({ identifier, password: dto.password });
    if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
    return r.value;
  }

  /** POST /auth/change-password — PUBLIC: the must-change user has no token yet,
   *  so they prove their current (temp) password to set a new one + receive a fresh JWT. */
  @Post("change-password")
  async changePassword(@Body() body: { email: string; currentPassword: string; newPassword: string }) {
    const dto = assertDto<{ email: string; currentPassword: string; newPassword: string }>(body, CHANGE_PASSWORD_DTO);
    const r = await this.auth.changePassword({
      email: dto.email.trim().toLowerCase(),
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
    });
    if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
    return r.value;
  }
}