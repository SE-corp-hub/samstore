// Rice Ops M11 — public owner sign-up is closed. Stores and their owners are created by
// the platform admin; owners add their own staff (Team). Reopen only with
// ALLOW_OWNER_SIGNUP=true. Kept out of the controller so it can be tested on its own.

import { HttpException, HttpStatus } from "@nestjs/common";

export function ownerSignupOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ALLOW_OWNER_SIGNUP ?? "").trim().toLowerCase() === "true";
}

/** Throws 403 unless the operator has reopened owner sign-up. */
export function assertOwnerSignupOpen(env: NodeJS.ProcessEnv = process.env): void {
  if (!ownerSignupOpen(env)) {
    throw new HttpException({ type: "forbidden", message: "Sign-up is closed. Ask the store owner to add you." }, HttpStatus.FORBIDDEN);
  }
}
