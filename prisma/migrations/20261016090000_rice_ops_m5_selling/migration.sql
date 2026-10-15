-- Rice Ops M5: selling — Benta by sack, kilo or peso; location prices; Bagong item
-- (Susuriin); Manual na pasok; Galing sa papel; a real idempotency key.
-- Additive only.

SET lock_timeout = '20s';

-- Bagong item: works at once, stays on the owner's review list until confirmed or merged.
CREATE TYPE "ProductReviewStatus" AS ENUM ('ACTIVE', 'FOR_REVIEW', 'MERGED');
ALTER TABLE "Product" ADD COLUMN "reviewStatus" "ProductReviewStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Product" ADD COLUMN "createdById" TEXT;
ALTER TABLE "Product" ADD COLUMN "mergedIntoId" TEXT;
CREATE INDEX "Product_storeId_reviewStatus_idx" ON "Product"("storeId", "reviewStatus");

-- A sale belongs to the location that sold it; a paper slip keeps its real time.
ALTER TABLE "Order" ADD COLUMN "sellingLocationId" TEXT;
ALTER TABLE "Order" ADD COLUMN "occurredAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "paperSlipNo" TEXT;
ALTER TABLE "Order" ADD COLUMN "encodedLater" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD CONSTRAINT "Order_sellingLocationId_fkey" FOREIGN KEY ("sellingLocationId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Order_storeId_sellingLocationId_createdAt_idx" ON "Order"("storeId", "sellingLocationId", "createdAt");
-- One paper slip is encoded once per store.
CREATE UNIQUE INDEX "Order_storeId_paperSlipNo_key" ON "Order"("storeId", "paperSlipNo");

-- A loose-rice line: grams sold and, for a sale by peso, the pesos asked.
ALTER TABLE "OrderItem" ADD COLUMN "soldBy" TEXT; -- PIECE | KILO | PESO (null = legacy)
ALTER TABLE "OrderItem" ADD COLUMN "grams" INTEGER;
ALTER TABLE "OrderItem" ADD COLUMN "enteredAmountMinor" INTEGER;
ALTER TABLE "OrderItem" ADD COLUMN "sourceLocationId" TEXT;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_weight_sane" CHECK (
  ("grams" IS NULL OR "grams" > 0) AND ("enteredAmountMinor" IS NULL OR "enteredAmountMinor" > 0)
);

-- Each location keeps its own drawer.
ALTER TABLE "Register" ADD COLUMN "locationId" TEXT;
ALTER TABLE "Register" ADD CONSTRAINT "Register_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Manual na pasok: stock in without a purchase order (supplier delivers to a store).
CREATE TABLE "StockIn" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "supplierName" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockIn_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockIn_storeId_docNumber_key" ON "StockIn"("storeId", "docNumber");
CREATE INDEX "StockIn_storeId_locationId_createdAt_idx" ON "StockIn"("storeId", "locationId", "createdAt");
ALTER TABLE "StockIn" ADD CONSTRAINT "StockIn_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockIn" ADD CONSTRAINT "StockIn_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StockInLine" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "stockInId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL, -- stock units: sacks, or grams for loose rice
    "unitCostMinor" INTEGER,
    CONSTRAINT "StockInLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockInLine_positive" CHECK ("quantity" > 0 AND ("unitCostMinor" IS NULL OR "unitCostMinor" >= 0))
);
CREATE INDEX "StockInLine_storeId_stockInId_idx" ON "StockInLine"("storeId", "stockInId");
ALTER TABLE "StockInLine" ADD CONSTRAINT "StockInLine_stockInId_fkey" FOREIGN KEY ("stockInId") REFERENCES "StockIn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockInLine" ADD CONSTRAINT "StockInLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockIn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockInLine" ENABLE ROW LEVEL SECURITY;
