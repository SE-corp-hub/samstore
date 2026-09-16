-- StoreSettings.dailySalesTargetMinor: daily sales target for Overview (0 = off)
ALTER TABLE "StoreSettings" ADD COLUMN "dailySalesTargetMinor" INTEGER NOT NULL DEFAULT 0;