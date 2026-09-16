-- CreateEnum
CREATE TYPE "OrderFulfillmentType" AS ENUM ('PICKUP', 'DELIVERY');

-- DropForeignKey
ALTER TABLE "CartItem" DROP CONSTRAINT "CartItem_productId_fkey";

-- DropForeignKey
ALTER TABLE "CreditEntry" DROP CONSTRAINT "CreditEntry_storeCustomerId_fkey";

-- DropForeignKey
ALTER TABLE "LoyaltyEntry" DROP CONSTRAINT "LoyaltyEntry_storeCustomerId_fkey";

-- DropForeignKey
ALTER TABLE "OrderClaimToken" DROP CONSTRAINT "OrderClaimToken_orderId_fkey";

-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_orderId_fkey";

-- DropForeignKey
ALTER TABLE "OrderStatusHistory" DROP CONSTRAINT "OrderStatusHistory_orderId_fkey";

-- DropForeignKey
ALTER TABLE "ProductImage" DROP CONSTRAINT "ProductImage_productId_fkey";

-- DropForeignKey
ALTER TABLE "PurchaseItem" DROP CONSTRAINT "PurchaseItem_productId_fkey";

-- DropForeignKey
ALTER TABLE "StockLevel" DROP CONSTRAINT "StockLevel_productId_fkey";

-- DropForeignKey
ALTER TABLE "VoucherRedemption" DROP CONSTRAINT "VoucherRedemption_voucherId_fkey";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fulfillmentType" "OrderFulfillmentType" NOT NULL DEFAULT 'DELIVERY';

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "delta" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "orderId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "balanceAfter" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockMovement_storeId_productId_createdAt_idx" ON "StockMovement"("storeId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_storeId_type_createdAt_idx" ON "StockMovement"("storeId", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_storeId_id_key" ON "StockMovement"("storeId", "id");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent"("aggregateType", "aggregateId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_storeId_id_key" ON "Order"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Product_storeId_id_key" ON "Product"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_storeId_id_key" ON "Purchase"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_storeId_id_key" ON "StockLevel"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StoreCustomer_storeId_id_key" ON "StoreCustomer"("storeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_storeId_id_key" ON "Voucher"("storeId", "id");

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_storeId_productId_fkey" FOREIGN KEY ("storeId", "productId") REFERENCES "Product"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_storeId_productId_fkey" FOREIGN KEY ("storeId", "productId") REFERENCES "Product"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_storeId_productId_fkey" FOREIGN KEY ("storeId", "productId") REFERENCES "Product"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_storeId_productId_fkey" FOREIGN KEY ("storeId", "productId") REFERENCES "Product"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyEntry" ADD CONSTRAINT "LoyaltyEntry_storeId_storeCustomerId_fkey" FOREIGN KEY ("storeId", "storeCustomerId") REFERENCES "StoreCustomer"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_storeId_voucherId_fkey" FOREIGN KEY ("storeId", "voucherId") REFERENCES "Voucher"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_storeId_orderId_fkey" FOREIGN KEY ("storeId", "orderId") REFERENCES "Order"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_storeId_orderId_fkey" FOREIGN KEY ("storeId", "orderId") REFERENCES "Order"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderClaimToken" ADD CONSTRAINT "OrderClaimToken_storeId_orderId_fkey" FOREIGN KEY ("storeId", "orderId") REFERENCES "Order"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_storeId_storeCustomerId_fkey" FOREIGN KEY ("storeId", "storeCustomerId") REFERENCES "StoreCustomer"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_storeId_productId_fkey" FOREIGN KEY ("storeId", "productId") REFERENCES "Product"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- M3: backfill explicit fulfillment from the address signal (the locked
-- discriminator — deliveryType cannot be trusted: it defaults to 'delivery').
UPDATE "Order" SET "fulfillmentType" = 'PICKUP' WHERE btrim(coalesce("deliveryAddressLine1", '')) = '';

-- M3: verify (informational — reported in the module report)
-- SELECT "fulfillmentType", count(*) FROM "Order" GROUP BY 1;
