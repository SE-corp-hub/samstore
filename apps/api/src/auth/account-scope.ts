// Rice Ops M11 — what one store may do to a person's ACCOUNT (not just their membership).
//
// A person can belong to more than one store. Before M11, inviting or re-roling them in
// store A rewrote their account-wide role (User.role), and store A's owner could reset
// their password — so store A could invite store B's owner by phone, reset the password,
// and log in as store B's owner. Now a store only touches the account when the account
// is that store's alone:
//  - the account-wide role follows the store role only for a single-store account, and
//    is never changed for a platform admin;
//  - a store owner may reset the password only of someone who works at no other store
//    (the platform admin, or the person themselves, handles the rest);
//  - removing someone signs them out everywhere only when no other store still uses them.

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = Pick<PrismaClient | Prisma.TransactionClient, "user" | "userStore">;

/** The account-wide role that matches a store role. */
export function globalRoleFor(storeRole: string): string {
  return storeRole === "OWNER" ? "STORE_OWNER" : storeRole;
}

/** Pure rule: may a store-level change touch this account? */
export function storeOwnsAccount(accountRole: string, otherActiveStores: number): boolean {
  return accountRole !== "PLATFORM_ADMIN" && otherActiveStores === 0;
}

/** ACTIVE memberships this user has in stores other than `storeId`. */
export function otherActiveStores(db: Db, userId: string, storeId: string): Promise<number> {
  return db.userStore.count({ where: { userId, status: "ACTIVE", storeId: { not: storeId } } });
}

/** Whether `storeId` alone may manage this account (password reset, sign-out everywhere). */
export async function accountBelongsToStore(db: Db, userId: string, storeId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) return false;
  return storeOwnsAccount(user.role, await otherActiveStores(db, userId, storeId));
}

/** Align the account-wide role with a store role — only when the store owns the account. Returns whether it changed. */
export async function alignGlobalRole(db: Db, userId: string, storeId: string, storeRole: string): Promise<boolean> {
  if (!(await accountBelongsToStore(db, userId, storeId))) return false;
  await db.user.update({ where: { id: userId }, data: { role: globalRoleFor(storeRole) } });
  return true;
}
