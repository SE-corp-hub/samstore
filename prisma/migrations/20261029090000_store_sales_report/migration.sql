-- Weekly sales total reported by a store that does not use the POS.
CREATE TABLE "StoreSalesReport" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "reportedMinor" INTEGER NOT NULL,
    "expectedMinor" INTEGER NOT NULL,
    "fromAt" TIMESTAMP(3) NOT NULL,
    "toAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreSalesReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StoreSalesReport_storeId_locationId_createdAt_idx" ON "StoreSalesReport"("storeId", "locationId", "createdAt");
