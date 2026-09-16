import { Body, Controller, HttpException, HttpStatus, Inject, Post } from "@nestjs/common";
import { OrderLookupService, ORDER_LOOKUP_SERVICE } from "./order-lookup.service.js";
import { assertDto, CLAIM_DTO } from "../security/validate.js";

// Public order tracking — a guest uses the single-use signed claim link to view their order.

@Controller("public")
export class OrderLookupController {
  constructor(
    @Inject(ORDER_LOOKUP_SERVICE)
    private readonly lookup: OrderLookupService,
  ) {}

  /** POST /public/orders/claim — exchange the claim token for the order view (single-use). */
  @Post("orders/claim")
  async claimOrder(@Body() body: { claimToken: string }) {
    const dto = assertDto<{ claimToken: string }>(body, CLAIM_DTO);
    const result = await this.lookup.claimOrder(dto.claimToken);
    if (!result.ok) {
      const status = result.error.type === "unauthorized"
        ? HttpStatus.UNAUTHORIZED
        : result.error.type === "conflict"
          ? HttpStatus.CONFLICT
          : HttpStatus.BAD_REQUEST;
      throw new HttpException(result.error, status);
    }
    return result.value;
  }
}