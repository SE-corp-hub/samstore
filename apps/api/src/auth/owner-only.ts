// Who can change what (2026-11-21): settings that change the WHOLE business are the owner's.
// A manager can look at them (the screens show them locked); counter staff and store heads do not
// get them. The table the app shows is apps/web/src/lib/who-can.ts; auth/who-can.test.ts checks
// this server against it.

import { HttpException, HttpStatus } from "@nestjs/common";

export const OWNER_SIDE = ["OWNER", "STORE_OWNER", "PLATFORM_ADMIN"] as const;

export const isOwnerSide = (role: string): boolean => (OWNER_SIDE as readonly string[]).includes(role);

export const OWNER_ONLY_MESSAGE = "Only the owner can change this. It changes the whole business.";

/** Refuses (403) anyone but the owner, with a plain message the screen can show. */
export function requireOwner(role: string, message = OWNER_ONLY_MESSAGE): void {
  if (!isOwnerSide(role)) throw new HttpException({ type: "forbidden", message }, HttpStatus.FORBIDDEN);
}
