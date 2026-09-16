import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import type { ApiError } from "@sam-store/contracts";
import { CartService, CART_SERVICE } from "./cart.service.js";
import { Inject } from "@nestjs/common";
import { assertDto, CART_ADD_DTO, CART_QTY_DTO } from "../security/validate.js";

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

// Public guest-cart endpoints (no auth — the high-entropy token is the access control).

@Controller("public/carts")
export class CartController {
  constructor(@Inject(CART_SERVICE) private readonly carts: CartService) {}

  /** POST /public/carts — new empty guest cart */
  @Post()
  async create() {
    const r = await this.carts.createCart();
    if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
    return r.value;
  }

  /** GET /public/carts/:token — full cart with product details */
  @Get(":token")
  async get(@Param("token") token: string) {
    const r = await this.carts.getCart(token);
    if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
    return r.value;
  }

  /** POST /public/carts/:token/items — add a product (binds store on first add) */
  @Post(":token/items")
  async add(@Param("token") token: string, @Body() body: { productId: string; quantity: number }) {
    const dto = assertDto<{ productId: string; quantity: number }>(body, CART_ADD_DTO);
    const r = await this.carts.addItem(token, dto.productId, dto.quantity);
    if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
    return r.value;
  }

  /** PATCH /public/carts/:token/items/:productId — set quantity */
  @Patch(":token/items/:productId")
  async updateQty(
    @Param("token") token: string,
    @Param("productId") productId: string,
    @Body() body: { quantity: number },
  ) {
    const dto = assertDto<{ quantity: number }>(body, CART_QTY_DTO);
    const r = await this.carts.updateQuantity(token, productId, dto.quantity);
    if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
    return r.value;
  }

  /** DELETE /public/carts/:token/items/:productId — remove line */
  @Delete(":token/items/:productId")
  async remove(@Param("token") token: string, @Param("productId") productId: string) {
    const r = await this.carts.removeItem(token, productId);
    if (!r.ok) throw new HttpException(r.error, statusFor(r.error));
    return r.value;
  }
}