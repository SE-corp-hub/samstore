-- Store payable: what a store owes the main store for rice that left without a record.
CREATE TABLE "StorePayableEntry" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "productId" TEXT,
    "quantity" INTEGER,
    "unitCostMinor" INTEGER,
    "sourceLocationId" TEXT,
    "sourceLineId" TEXT,
    "reversesId" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorePayableEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StorePayableEntry_sourceLineId_key" ON "StorePayableEntry"("sourceLineId");
CREATE UNIQUE INDEX "StorePayableEntry_reversesId_key" ON "StorePayableEntry"("reversesId");
CREATE UNIQUE INDEX "StorePayableEntry_storeId_docNumber_key" ON "StorePayableEntry"("storeId", "docNumber");
CREATE INDEX "StorePayableEntry_storeId_locationId_createdAt_idx" ON "StorePayableEntry"("storeId", "locationId", "createdAt");
