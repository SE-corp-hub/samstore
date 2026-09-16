-- A1: phone-primary identity — User gains optional E.164 phone (unique), email becomes optional
--
-- Postgres unique indexes allow many NULLs: the existing email unique index is
-- untouched (one row per present email, unlimited NULL rows). Existing accounts
-- keep email as their login identifier (D2); the migration itself leaves their
-- email values in place and backfills NO fake phones (the seed gets placeholder
-- PH phones; production rows are verified/released via A2).

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");