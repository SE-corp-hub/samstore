-- Rice Ops M8: Bilangin (blind counts, quick counts, the closing top-5), the balance, and
-- Manual na bawas (write-offs). Additive only.

SET lock_timeout = '20s';

CREATE TYPE "CountKind" AS ENUM ('FULL', 'PARTIAL', 'QUICK', 'CLOSING');
CREATE TYPE "CountStatus" AS ENUM ('OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED');

CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "kind" "CountKind" NOT NULL,
    "status" "CountStatus" NOT NULL DEFAULT 'OPEN',
    "blind" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "approvalId" TEXT,
    "kulangValueMinor" INTEGER NOT NULL DEFAULT 0,
    "sobraValueMinor" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StockCount_storeId_docNumber_key" ON "StockCount"("storeId", "docNumber");
CREATE INDEX "StockCount_storeId_locationId_status_idx" ON "StockCount"("storeId", "locationId", "status");
CREATE INDEX "StockCount_storeId_startedAt_idx" ON "StockCount"("storeId", "startedAt");
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "expectedQty" INTEGER, -- what the system had when this line was counted (hidden from staff on a blind count)
    "countedQty" INTEGER,
    "countedAt" TIMESTAMP(3),
    "countedById" TEXT,
    "varianceQty" INTEGER,
    "varianceValueMinor" INTEGER,
    "postedQty" INTEGER, -- the COUNT_ADJUST actually posted (= variance once approved)
    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockCountLine_sane" CHECK ("countedQty" IS NULL OR ("countedQty" >= 0 AND "expectedQty" IS NOT NULL AND "countedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "StockCountLine_countId_productId_key" ON "StockCountLine"("countId", "productId");
CREATE INDEX "StockCountLine_storeId_productId_countedAt_idx" ON "StockCountLine"("storeId", "productId", "countedAt");
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "WriteOffReason" AS ENUM ('TAPON', 'BASA', 'BUKBOK', 'SAMPLE', 'BIGAY', 'IBA');

CREATE TABLE "StockWriteOff" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" "WriteOffReason" NOT NULL,
    "note" TEXT,
    "valueMinor" INTEGER NOT NULL,
    "lossBp" INTEGER NOT NULL,
    "approvalId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockWriteOff_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockWriteOff_positive" CHECK ("quantity" > 0 AND "valueMinor" >= 0)
);
CREATE UNIQUE INDEX "StockWriteOff_storeId_docNumber_key" ON "StockWriteOff"("storeId", "docNumber");
CREATE INDEX "StockWriteOff_storeId_locationId_createdAt_idx" ON "StockWriteOff"("storeId", "locationId", "createdAt");
ALTER TABLE "StockWriteOff" ADD CONSTRAINT "StockWriteOff_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockWriteOff" ADD CONSTRAINT "StockWriteOff_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockWriteOff" ADD CONSTRAINT "StockWriteOff_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockCount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockCountLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockWriteOff" ENABLE ROW LEVEL SECURITY;
