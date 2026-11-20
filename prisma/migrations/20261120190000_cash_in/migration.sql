-- Cash in on POS: money put into a store's drawer that is not a sale (more change, the owner adds money).
-- Add-only: one new table. Nothing existing changes.

CREATE TABLE "CashIn" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashIn_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "CashIn" ENABLE ROW LEVEL SECURITY;

CREATE INDEX "CashIn_storeId_locationId_receivedAt_idx" ON "CashIn"("storeId", "locationId", "receivedAt");

ALTER TABLE "CashIn" ADD CONSTRAINT "CashIn_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashIn" ADD CONSTRAINT "CashIn_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
