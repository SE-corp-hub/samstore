import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Post, Query } from "@nestjs/common";
import type { CheckoutResponse } from "@sam-store/contracts";
import { assertDto, HUB_ORDER_DTO } from "../security/validate.js";
import { HUB_ORDER_SERVICE, HubOrderService, hubSecretOk, type HubOrderRequest } from "./hub-orders.service.js";

const STATUS: Record<string, HttpStatus> = {
  validation: HttpStatus.UNPROCESSABLE_ENTITY,
  not_found: HttpStatus.NOT_FOUND,
  forbidden: HttpStatus.FORBIDDEN,
  unauthorized: HttpStatus.UNAUTHORIZED,
  rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  conflict: HttpStatus.CONFLICT,
};

@Controller("integrations/hub")
export class HubOrdersController {
  constructor(@Inject(HUB_ORDER_SERVICE) private readonly hub: HubOrderService) {}

  /**
   * POST /integrations/hub/orders — SE Corp Hub hands over an order it took on a selling page.
   * Locked by the shared secret in `x-hub-secret` (HUB_ORDER_SECRET, 32+ characters). With no secret
   * set the door does not exist (404), so a fresh deploy never accepts orders from anyone.
   */
  @Post("orders")
  async place(@Headers("x-hub-secret") secret: string | undefined, @Body() body: HubOrderRequest): Promise<CheckoutResponse> {
    door(secret);
    const dto = assertDto<HubOrderRequest>(body, HUB_ORDER_DTO);
    const result = await this.hub.place(dto);
    if (!result.ok) throw new HttpException(result.error, STATUS[result.error.type] ?? HttpStatus.BAD_REQUEST);
    return result.value;
  }

  /** GET /integrations/hub/products?store=<slug> — the store's items and prices, which the hub copies. Same lock. */
  @Get("products")
  async products(@Headers("x-hub-secret") secret: string | undefined, @Query("store") slug: unknown) {
    door(secret);
    if (typeof slug !== "string" || slug.length === 0 || slug.length > 120) {
      throw new HttpException({ type: "validation", errors: ["store is invalid"] }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const list = await this.hub.products(slug);
    if (!list) throw new HttpException({ type: "not_found", message: "Store not found" }, HttpStatus.NOT_FOUND);
    return { products: list };
  }
}

/** Shut (404) while HUB_ORDER_SECRET is unset or short; 401 for a wrong secret. */
function door(secret: string | undefined): void {
  const expected = process.env.HUB_ORDER_SECRET;
  if (!expected || expected.length < 32) {
    throw new HttpException({ type: "not_found", message: "Not found" }, HttpStatus.NOT_FOUND);
  }
  if (!hubSecretOk(secret, expected)) {
    throw new HttpException({ type: "unauthorized", message: "Wrong or missing hub secret" }, HttpStatus.UNAUTHORIZED);
  }
}
