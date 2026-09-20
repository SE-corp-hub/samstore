-- P3b: statutory 20% discount for Senior Citizens / PWDs (RA 9994 / RA 10754).
-- Store toggle + Order ID capture snapshot columns.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "statutoryName" TEXT,
ADD COLUMN     "statutoryType" TEXT,
ADD COLUMN     "statutoryId" TEXT;

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "seniorPwdDiscountEnabled" BOOLEAN NOT NULL DEFAULT false;