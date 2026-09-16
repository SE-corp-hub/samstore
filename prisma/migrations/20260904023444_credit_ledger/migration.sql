-- AlterTable
ALTER TABLE "StoreCustomer" ADD COLUMN     "creditApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "creditBalanceMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creditLimitMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "creditLimitMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CreditEntry" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "storeCustomerId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditEntry_storeId_storeCustomerId_createdAt_idx" ON "CreditEntry"("storeId", "storeCustomerId", "createdAt");

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_storeCustomerId_fkey" FOREIGN KEY ("storeCustomerId") REFERENCES "StoreCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
