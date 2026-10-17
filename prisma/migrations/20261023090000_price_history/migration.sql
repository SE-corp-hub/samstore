-- Cost and price history: one line per change, kept forever.
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "field" TEXT NOT NULL,
    "oldMinor" INTEGER NOT NULL,
    "newMinor" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "reason" TEXT,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PriceHistory_storeId_productId_createdAt_idx" ON "PriceHistory"("storeId", "productId", "createdAt");

-- Cost per location (the store chooses; the default keeps one cost per product).
ALTER TABLE "StockLevel" ADD COLUMN "costMinor" INTEGER;
ALTER TABLE "StoreSettings" ADD COLUMN "costMode" TEXT NOT NULL DEFAULT 'SHARED';
