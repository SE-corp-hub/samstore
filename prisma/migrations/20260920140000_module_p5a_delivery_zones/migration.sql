-- P5a: delivery zones — per-store per-city/barangay delivery pricing + ETA.
-- Checkout resolves the zone from the PH address; no match = out of coverage.

-- CreateTable
CREATE TABLE "DeliveryZone" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cityCode" TEXT,
    "barangayCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "feeMinor" INTEGER NOT NULL,
    "etaMinutes" INTEGER NOT NULL DEFAULT 45,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryZone_storeId_name_key" ON "DeliveryZone"("storeId", "name");
CREATE INDEX "DeliveryZone_storeId_isActive_idx" ON "DeliveryZone"("storeId", "isActive");

-- AddForeignKey
ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "deliveryZoneName" TEXT,
ADD COLUMN "etaMinutes" INTEGER;