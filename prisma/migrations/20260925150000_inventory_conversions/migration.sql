-- Inventory conversion support for packed stock (products + variants).

ALTER TABLE "Product"
  ADD COLUMN "stockBaseUnit" TEXT,
  ADD COLUMN "stockBaseQuantity" INTEGER;

ALTER TABLE "ProductVariant"
  ADD COLUMN "costMinor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "stockBaseQuantity" INTEGER;

CREATE TABLE "StockConversion" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "sourceProductId" TEXT NOT NULL,
  "sourceVariantId" TEXT,
  "destinationProductId" TEXT NOT NULL,
  "destinationVariantId" TEXT,
  "warehouseId" TEXT,
  "sourceQuantity" INTEGER NOT NULL,
  "outputQuantity" INTEGER NOT NULL,
  "stockBaseUnit" TEXT NOT NULL,
  "sourceBaseQuantity" INTEGER NOT NULL,
  "destinationBaseQuantity" INTEGER NOT NULL,
  "wasteBaseQuantity" INTEGER NOT NULL DEFAULT 0,
  "sourceValueMinor" INTEGER NOT NULL DEFAULT 0,
  "outputValueMinor" INTEGER NOT NULL DEFAULT 0,
  "wasteValueMinor" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL,
  "wasteReason" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StockConversion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StockConversion_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StockConversion_storeId_id_key" ON "StockConversion"("storeId", "id");
CREATE INDEX "StockConversion_storeId_createdAt_idx" ON "StockConversion"("storeId", "createdAt");

ALTER TABLE "StockMovement"
  ADD COLUMN "conversionId" TEXT;

ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "StockConversion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "StockMovement_storeId_conversionId_idx" ON "StockMovement"("storeId", "conversionId");
