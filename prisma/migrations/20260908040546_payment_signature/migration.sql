-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "signatureAt" TIMESTAMP(3),
ADD COLUMN     "signatureData" TEXT;
