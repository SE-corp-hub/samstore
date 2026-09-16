-- AlterEnum
ALTER TYPE "LoyaltyEntryType" ADD VALUE 'ADJUST';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "signatureAt" TIMESTAMP(3),
ADD COLUMN     "signatureData" TEXT;
