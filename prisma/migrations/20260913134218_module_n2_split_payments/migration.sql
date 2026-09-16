-- CreateEnum
CREATE TYPE "PaymentMethodKind" AS ENUM ('CASH', 'CREDIT', 'EWALLET', 'TRANSFER', 'OTHER');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "tenderedMinor" INTEGER;

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "PaymentMethodKind" NOT NULL DEFAULT 'OTHER',
    "requiresReference" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentMethod_storeId_enabled_idx" ON "PaymentMethod"("storeId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_storeId_code_key" ON "PaymentMethod"("storeId", "code");

-- CreateIndex
CREATE INDEX "Payment_storeId_idempotencyKey_idx" ON "Payment"("storeId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

