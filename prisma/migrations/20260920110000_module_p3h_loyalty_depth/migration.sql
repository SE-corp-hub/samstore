-- P3h: loyalty configuration — earn rate (pts per ₱1), one-time welcome bonus,
-- points expiry period (months; 0 = never expires).

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN "loyaltyPointsPerPeso" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "loyaltyWelcomeBonusPoints" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "loyaltyExpiryMonths" INTEGER NOT NULL DEFAULT 0;