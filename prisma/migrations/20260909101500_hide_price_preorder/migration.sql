-- StoreSettings.hidePricePreOrder: hide per-product prices in Pre Orders screen
ALTER TABLE "StoreSettings" ADD COLUMN "hidePricePreOrder" BOOLEAN NOT NULL DEFAULT false;