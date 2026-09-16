-- CreateTable
CREATE TABLE "Voucher" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discountMinor" INTEGER NOT NULL,
    "minOrderMinor" INTEGER NOT NULL DEFAULT 0,
    "maxRedemptions" INTEGER,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherRedemption" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoucherRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Voucher_storeId_isActive_idx" ON "Voucher"("storeId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_storeId_code_key" ON "Voucher"("storeId", "code");

-- CreateIndex
CREATE INDEX "VoucherRedemption_storeId_createdAt_idx" ON "VoucherRedemption"("storeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VoucherRedemption_voucherId_orderId_key" ON "VoucherRedemption"("voucherId", "orderId");

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
