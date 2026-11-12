-- Per-store plan (one shared stock; own prices, profit, expenses, cash and logins per store).
-- ONE add-only update that holds every new field the ten build steps need. It adds columns,
-- one table and three indexes; it changes and removes nothing, so the app that is running
-- today keeps working before and after it. Each build step then adds its fields to
-- prisma/schema.prisma (the exact model lines are in docs/per-store-build.md).
SET lock_timeout = '20s';

-- Step 3: expenses belong to a place (empty = the whole business); a wrong one is cancelled, not deleted.
ALTER TABLE "Expense" ADD COLUMN "locationId" TEXT,
ADD COLUMN "paidFromDrawer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "voidReason" TEXT,
ADD COLUMN "voidedAt" TIMESTAMP(3),
ADD COLUMN "voidedById" TEXT;

-- Step 4: cash a store hands over to the owner (lowers that store's expected cash).
CREATE TABLE "CashHandover" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "note" TEXT,
    "handedById" TEXT NOT NULL,
    "receivedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashHandover_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "CashHandover" ENABLE ROW LEVEL SECURITY;

-- Step 4: credit paid at one store for a sale another store made: the store the money is for.
ALTER TABLE "Payment" ADD COLUMN "forLocationId" TEXT;

-- Step 7: the head of a store, and the lowest price a head may set.
-- Step 8: a ready-made login waiting to be handed over ("Lipa head").
ALTER TABLE "UserStore" ADD COLUMN "isLocationHead" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "readyLabel" TEXT;
ALTER TABLE "Product" ADD COLUMN "floorPriceMinor" INTEGER;

-- Step 2: the places a store may take rice from, in order, and its Facebook Page.
-- Step 9: each store's own receipt name and text, daily target and order prefix.
ALTER TABLE "Warehouse" ADD COLUMN "dailySalesTargetMinor" INTEGER,
ADD COLUMN "facebookPageUrl" TEXT,
ADD COLUMN "orderPrefix" TEXT,
ADD COLUMN "receiptContact" TEXT,
ADD COLUMN "receiptFooter" TEXT,
ADD COLUMN "receiptHeader" TEXT,
ADD COLUMN "receiptName" TEXT,
ADD COLUMN "sourceLocationIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "CashHandover_storeId_locationId_businessDate_idx" ON "CashHandover"("storeId", "locationId", "businessDate");
CREATE INDEX "Expense_storeId_locationId_spentAt_idx" ON "Expense"("storeId", "locationId", "spentAt");
-- Step 1: a store's sales by the day they became final.
CREATE INDEX "Order_storeId_sellingLocationId_occurredAt_idx" ON "Order"("storeId", "sellingLocationId", "occurredAt");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_forLocationId_fkey" FOREIGN KEY ("forLocationId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CashHandover" ADD CONSTRAINT "CashHandover_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashHandover" ADD CONSTRAINT "CashHandover_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
