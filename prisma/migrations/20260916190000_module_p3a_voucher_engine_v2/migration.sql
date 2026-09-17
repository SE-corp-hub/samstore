-- P3a: voucher engine v2 — percent / free-delivery / first-order / per-customer /
-- scoped / stackable vouchers + per-customer redemption accounting.

-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "perCustomerLimit" INTEGER,
ADD COLUMN     "percentBp" INTEGER,
ADD COLUMN     "scopeRefId" TEXT,
ADD COLUMN     "scopeType" TEXT NOT NULL DEFAULT 'all',
ADD COLUMN     "stackable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'fixed';

-- AlterTable
ALTER TABLE "VoucherRedemption" ADD COLUMN     "storeCustomerId" TEXT;

-- CreateIndex
CREATE INDEX "VoucherRedemption_voucherId_storeCustomerId_idx" ON "VoucherRedemption"("voucherId", "storeCustomerId");