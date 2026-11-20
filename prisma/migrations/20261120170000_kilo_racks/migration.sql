-- Sell per kilo — display racks: one kilo item filled from several sacks. Add-only.
CREATE TABLE "RackSack" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kiloProductId" TEXT NOT NULL,
    "sackProductId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RackSack_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RackSack_storeId_kiloProductId_sackProductId_key" ON "RackSack"("storeId", "kiloProductId", "sackProductId");
CREATE INDEX "RackSack_storeId_sackProductId_idx" ON "RackSack"("storeId", "sackProductId");

ALTER TABLE "RackSack" ENABLE ROW LEVEL SECURITY;
