-- Count: a reason (and note) on each short/over line, the first number kept when a line is counted again,
-- and the two limits (count again / needs a look) in the store settings. Additive only.
ALTER TABLE "StockCountLine" ADD COLUMN "reason" TEXT,
ADD COLUMN "note" TEXT,
ADD COLUMN "firstCountedQty" INTEGER;

ALTER TABLE "StoreSettings" ADD COLUMN "countRecountMinor" INTEGER NOT NULL DEFAULT 50000,
ADD COLUMN "countLookMinor" INTEGER NOT NULL DEFAULT 100000;
