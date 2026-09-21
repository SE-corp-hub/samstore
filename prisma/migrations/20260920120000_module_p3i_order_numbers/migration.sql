-- P3i: configurable order-number prefix — when set, order numbers read
-- PIN-YYYY-NNNNNN (store counter + calendar year); null keeps the legacy
-- <SLUG>-NNNNNN format.

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN "orderNumberPrefix" TEXT;