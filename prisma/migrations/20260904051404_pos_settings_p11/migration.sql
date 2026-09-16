-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "receiptFooter" TEXT,
ADD COLUMN     "receiptHeader" TEXT,
ADD COLUMN     "showVatLabel" BOOLEAN NOT NULL DEFAULT true;
