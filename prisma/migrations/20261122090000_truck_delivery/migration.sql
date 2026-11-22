-- 2026-11-22 Truck delivery: one truck = what came, pre-orders handed out from the truck, and each shelf's share.
-- Add-only: a new table and one empty column on StockIn.
CREATE TABLE "TruckDelivery" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "supplierName" TEXT,
    "note" TEXT,
    "summary" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TruckDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TruckDelivery_storeId_docNumber_key" ON "TruckDelivery"("storeId", "docNumber");
CREATE INDEX "TruckDelivery_storeId_createdAt_idx" ON "TruckDelivery"("storeId", "createdAt");
ALTER TABLE "TruckDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockIn" ADD COLUMN "truckId" TEXT;
