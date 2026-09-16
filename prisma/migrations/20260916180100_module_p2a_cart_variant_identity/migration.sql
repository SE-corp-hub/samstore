-- P2a fix: line identity uses "" sentinel instead of NULL (Postgres unique treats
-- NULLs as distinct → plain-product lines would duplicate). The variant FK is dropped:
-- "" cannot reference a variant, and tenant integrity stays enforced at the app layer.

-- DropForeignKey
ALTER TABLE "CartItem" DROP CONSTRAINT IF EXISTS "CartItem_storeId_variantId_fkey";

-- Backfill existing rows (pre-P2a carts) to the "" sentinel before NOT NULL.
UPDATE "CartItem" SET "variantId" = '' WHERE "variantId" IS NULL;
UPDATE "CartItem" SET "addonKey" = '' WHERE "addonKey" IS NULL;

-- AlterTable
ALTER TABLE "CartItem" ALTER COLUMN "addonKey" SET NOT NULL,
ALTER COLUMN "addonKey" SET DEFAULT '',
ALTER COLUMN "variantId" SET NOT NULL,
ALTER COLUMN "variantId" SET DEFAULT '';