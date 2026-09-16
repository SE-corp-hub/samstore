import { Controller, Get, Param, Query, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { PublicStoreService } from "./public-store.service.js";

// Public-facing storefront endpoints (no auth — the PUBLIC LINK is the access
// control: slug + high-entropy token, both required, ACTIVE link only).

@Controller("public")
export class PublicStoreController {
  constructor(@Inject(PublicStoreService) private readonly stores: PublicStoreService) {}

  /** GET /public/stores/:slug?token= — public store profile + active products. */
  @Get("stores/:slug")
  async getStore(@Param("slug") slug: string, @Query("token") token?: string) {
    // Module 2 fix: bound the untrusted path/query input before it reaches the DB.
    if (typeof slug !== "string" || slug.length === 0 || slug.length > 120) {
      throw new HttpException({ type: "validation", errors: ["slug is invalid"] }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (token !== undefined && (typeof token !== "string" || token.length > 300)) {
      throw new HttpException({ type: "validation", errors: ["token is invalid"] }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const result = await this.stores.getStore(slug, token);
    if (!result) {
      throw new HttpException({ type: "not_found", message: "Store not found" }, HttpStatus.NOT_FOUND);
    }
    if (result.closed) {
      return result.store;
    }
    return { store: result.store, products: result.products };
  }
}