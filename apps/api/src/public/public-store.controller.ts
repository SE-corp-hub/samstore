import { Controller, Get, Post, Body, Param, Query, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { PublicStoreService } from "./public-store.service.js";
import { MessengerBridgeService } from "../messenger/bridge.service.js";

// Public-facing storefront endpoints (no auth — the PUBLIC LINK is the access
// control: slug + high-entropy token, both required, ACTIVE link only).

@Controller("public")
export class PublicStoreController {
  constructor(@Inject(PublicStoreService) private readonly stores: PublicStoreService) {}
  // P3g: Website→Messenger bridge — always suppress-send with portal status.
  private readonly bridge = new MessengerBridgeService();

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

  /** POST /public/stores/:slug/messenger/opt-in?token= — website→Messenger bridge.
   *  Slug + token gated (same as the storefront). Sends stay suppressed by default;
   *  the response carries the honest portal status. A PSID is never guessed. */
  @Post("stores/:slug/messenger/opt-in")
  async messengerOptIn(
    @Param("slug") slug: string,
    @Query("token") token?: string,
    @Body() body?: { psid?: string; text?: string },
  ) {
    if (typeof slug !== "string" || slug.length === 0 || slug.length > 120) {
      throw new HttpException({ type: "validation", errors: ["slug is invalid"] }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (token !== undefined && (typeof token !== "string" || token.length > 300)) {
      throw new HttpException({ type: "validation", errors: ["token is invalid"] }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const psid = typeof body?.psid === "string" ? body.psid.trim().slice(0, 300) : undefined;
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, 640) : undefined;
    const storeId = await this.stores.resolveStoreId(slug, token);
    if (!storeId) {
      throw new HttpException({ type: "not_found", message: "Store not found" }, HttpStatus.NOT_FOUND);
    }
    const result = await this.bridge.bridgeOptIn(storeId, { psid, text });
    if (!result.ok) {
      throw new HttpException(result.error, HttpStatus.NOT_FOUND);
    }
    return result.value;
  }
}