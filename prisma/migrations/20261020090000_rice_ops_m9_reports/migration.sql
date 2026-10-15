-- Rice Ops M9: reports — the cost frozen with each sale line (gross profit), and the
-- per-location closing (Pagsasara) that locks the day's report. Additive only.

SET lock_timeout = '20s';

ALTER TABLE "OrderItem" ADD COLUMN "unitCostMinor" INTEGER; -- per piece, or per KILO for loose rice; null = legacy line

CREATE TABLE "DailyClose" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL, -- YYYY-MM-DD, Manila
    "totals" JSONB NOT NULL,
    "cashExpectedMinor" INTEGER NOT NULL,
    "cashCountedMinor" INTEGER NOT NULL,
    "cashVarianceMinor" INTEGER NOT NULL,
    "closingCountId" TEXT,
    "note" TEXT,
    "closedById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailyClose_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DailyClose_storeId_locationId_businessDate_key" ON "DailyClose"("storeId", "locationId", "businessDate");
CREATE INDEX "DailyClose_storeId_businessDate_idx" ON "DailyClose"("storeId", "businessDate");
ALTER TABLE "DailyClose" ADD CONSTRAINT "DailyClose_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyClose" ADD CONSTRAINT "DailyClose_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DailyClose" ENABLE ROW LEVEL SECURITY;

-- Reports read the ledger by location and time.
CREATE INDEX IF NOT EXISTS "StockMovement_storeId_warehouseId_createdAt_idx" ON "StockMovement"("storeId", "warehouseId", "createdAt");
CREATE INDEX IF NOT EXISTS "Signature_storeId_createdAt_idx" ON "Signature"("storeId", "createdAt");
