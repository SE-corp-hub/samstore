-- Open day + Close day (Z-read) on POS. Add-only: new columns, one index swapped.

ALTER TABLE "StoreSettings" ADD COLUMN "dayOpenClose" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "RegisterSession"
  ADD COLUMN "locationId" TEXT,
  ADD COLUMN "businessDate" TEXT,
  ADD COLUMN "zNumber" INTEGER,
  ADD COLUMN "gcashExpectedMinor" INTEGER,
  ADD COLUMN "gcashCountedMinor" INTEGER,
  ADD COLUMN "cashCounts" JSONB,
  ADD COLUMN "varianceReason" TEXT,
  ADD COLUMN "keepFloatMinor" INTEGER,
  ADD COLUMN "zTotals" JSONB,
  ADD COLUMN "reopenedAt" TIMESTAMP(3),
  ADD COLUMN "reopenedById" TEXT,
  ADD COLUMN "reopenReason" TEXT;

CREATE INDEX "RegisterSession_storeId_locationId_businessDate_idx" ON "RegisterSession"("storeId", "locationId", "businessDate");

-- Each store has its own drawer now: at most ONE open shift per REGISTER (was one per business).
-- Today every business has one register, so nothing that was allowed before is refused.
DROP INDEX IF EXISTS "RegisterSession_one_open_per_store";
CREATE UNIQUE INDEX "RegisterSession_one_open_per_register" ON "RegisterSession" ("registerId") WHERE "status" = 'OPEN';

-- One open day per store at a time, and a Z number is never given twice at one store.
CREATE UNIQUE INDEX "RegisterSession_one_open_day_per_location" ON "RegisterSession" ("storeId", "locationId") WHERE "status" = 'OPEN' AND "locationId" IS NOT NULL;
CREATE UNIQUE INDEX "RegisterSession_z_number_per_location" ON "RegisterSession" ("storeId", "locationId", "zNumber") WHERE "zNumber" IS NOT NULL;

-- The owner's own sale whose cash the owner kept: the hand-over row points at the sale.
ALTER TABLE "CashHandover" ADD COLUMN IF NOT EXISTS "orderId" TEXT;
CREATE INDEX IF NOT EXISTS "CashHandover_orderId_idx" ON "CashHandover"("orderId");
