-- Rice Ops M3: transfers become numbered, signed trips (Lipat / Ilabas / Tanggapin),
-- a sale can be served from another location (ORDER_RELEASE), and customer returns
-- (Ibinalik) are recorded. Additive; existing transfers keep their meaning.

SET lock_timeout = '20s';

-- 1. Status RETURNING + kind
ALTER TYPE "TransferStatus" ADD VALUE IF NOT EXISTS 'RETURNING';
CREATE TYPE "TransferKind" AS ENUM ('RESTOCK', 'ORDER_RELEASE');
CREATE TYPE "ReturnCondition" AS ENUM ('GOOD', 'DAMAGED');

-- 2. Transfer trip columns
ALTER TABLE "StockTransfer"
  ADD COLUMN "docNumber" TEXT,
  ADD COLUMN "kind" "TransferKind" NOT NULL DEFAULT 'RESTOCK',
  ADD COLUMN "orderId" TEXT,
  ADD COLUMN "kargadorId" TEXT,
  ADD COLUMN "reservedQty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "releasedQty" INTEGER,
  ADD COLUMN "receivedQty" INTEGER,
  ADD COLUMN "deliveredQty" INTEGER,
  ADD COLUMN "returnedQty" INTEGER,
  ADD COLUMN "shortQty" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "releasedAt" TIMESTAMP(3),
  ADD COLUMN "releasedById" TEXT,
  ADD COLUMN "receivedAt" TIMESTAMP(3),
  ADD COLUMN "receivedById" TEXT,
  ADD COLUMN "customerName" TEXT,
  ADD COLUMN "deliveryNote" TEXT;

-- Before M3, IN_TRANSIT moved no stock (only COMPLETED did). From M3 on, IN_TRANSIT
-- means "released at the source", so legacy IN_TRANSIT rows go back to APPROVED.
UPDATE "StockTransfer" SET "status" = 'APPROVED' WHERE "status" = 'IN_TRANSIT';
-- Completed legacy transfers moved their whole quantity in one step.
UPDATE "StockTransfer" SET "releasedQty" = "quantity", "receivedQty" = "quantity"
 WHERE "status" = 'COMPLETED' AND "releasedQty" IS NULL;

CREATE UNIQUE INDEX "StockTransfer_storeId_docNumber_key" ON "StockTransfer"("storeId", "docNumber");
CREATE INDEX "StockTransfer_storeId_fromWarehouseId_status_idx" ON "StockTransfer"("storeId", "fromWarehouseId", "status");
CREATE INDEX "StockTransfer_storeId_toWarehouseId_status_idx" ON "StockTransfer"("storeId", "toWarehouseId", "status");
CREATE INDEX "StockTransfer_storeId_orderId_idx" ON "StockTransfer"("storeId", "orderId");
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_kargadorId_fkey" FOREIGN KEY ("kargadorId") REFERENCES "Kargador"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Quantities can never be negative or exceed what came before them.
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_qty_sane" CHECK (
  "reservedQty" >= 0 AND "shortQty" >= 0
  AND ("releasedQty" IS NULL OR ("releasedQty" >= 0 AND "releasedQty" <= "quantity"))
  AND ("receivedQty" IS NULL OR ("receivedQty" >= 0 AND "receivedQty" <= COALESCE("releasedQty", 0)))
  AND ("deliveredQty" IS NULL OR ("deliveredQty" >= 0 AND "deliveredQty" <= COALESCE("releasedQty", 0)))
);

-- 3. StockReturn (Ibinalik)
CREATE TABLE "StockReturn" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "orderId" TEXT,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "condition" "ReturnCondition" NOT NULL,
    "reason" TEXT NOT NULL,
    "kargadorId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockReturn_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockReturn_quantity_positive" CHECK ("quantity" > 0)
);
CREATE UNIQUE INDEX "StockReturn_storeId_docNumber_key" ON "StockReturn"("storeId", "docNumber");
CREATE INDEX "StockReturn_storeId_createdAt_idx" ON "StockReturn"("storeId", "createdAt");
ALTER TABLE "StockReturn" ADD CONSTRAINT "StockReturn_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockReturn" ADD CONSTRAINT "StockReturn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockReturn" ADD CONSTRAINT "StockReturn_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockReturn" ADD CONSTRAINT "StockReturn_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockReturn" ADD CONSTRAINT "StockReturn_kargadorId_fkey" FOREIGN KEY ("kargadorId") REFERENCES "Kargador"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockReturn" ENABLE ROW LEVEL SECURITY;
