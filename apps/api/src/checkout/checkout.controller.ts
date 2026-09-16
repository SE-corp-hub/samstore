import { Body, Controller, HttpException, HttpStatus, Inject, Post } from "@nestjs/common";
import type { CheckoutRequest, CheckoutResponse, ApiError } from "@sam-store/contracts";
import { CHECKOUT_SERVICE, CheckoutService } from "./checkout.service.js";
import { assertDto, CHECKOUT_DTO } from "../security/validate.js";

// Public-facing routes. The storefront calls these from the canonical public link.
// Rate limiting is added at the gateway layer once Redis is wired (AGENTS.md: public link).

function httpStatusFor(error: ApiError): HttpStatus {
  switch (error.type) {
    case "validation":
      return HttpStatus.UNPROCESSABLE_ENTITY; // 422
    case "not_found":
      return HttpStatus.NOT_FOUND; // 404
    case "forbidden":
      return HttpStatus.FORBIDDEN; // 403
    case "unauthorized":
      return HttpStatus.UNAUTHORIZED; // 401
    case "rate_limited":
      return HttpStatus.TOO_MANY_REQUESTS; // 429
    case "conflict":
      return HttpStatus.CONFLICT; // 409
  }
}

@Controller("public")
export class CheckoutController {
  constructor(
    @Inject(CHECKOUT_SERVICE)
    private readonly checkoutService: CheckoutService,
  ) {}

  /**
   * POST /public/checkout
   * Creates a COD order from an open guest cart.
   * Success: 201 with order + single-use claim token.
   * Retry with the same idempotencyKey + cartToken: 200-style idempotent same order (201).
   */
  @Post("checkout")
  async checkout(@Body() body: CheckoutRequest): Promise<CheckoutResponse> {
    // Module 2 fix: the untrusted checkout body is shape-validated BEFORE any
    // domain work (types, enums, bounds, unknown keys rejected) → 422 not 500.
    const dto = assertDto<CheckoutRequest>(body, CHECKOUT_DTO);
    const result = await this.checkoutService.checkout(dto);
    if (!result.ok) {
      throw new HttpException(result.error, httpStatusFor(result.error));
    }
    return result.value;
  }
}