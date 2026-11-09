-- Quota promo: N sacks or more of the chosen groups in one sale → each of those sacks cheaper (owner switch).
ALTER TABLE "StoreSettings" ADD COLUMN "quotaPromoEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StoreSettings" ADD COLUMN "quotaPromoMinSacks" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "StoreSettings" ADD COLUMN "quotaPromoOffMinor" INTEGER NOT NULL DEFAULT 2000;
ALTER TABLE "StoreSettings" ADD COLUMN "quotaPromoCategoryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
