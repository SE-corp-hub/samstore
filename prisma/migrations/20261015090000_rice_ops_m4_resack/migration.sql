-- Rice Ops M4: resack (any rice into any rice), Buksan ang sako, Simulan/Tapusin.
-- Additive only.

SET lock_timeout = '20s';

ALTER TABLE "Product" ADD COLUMN "variety" TEXT;

CREATE TYPE "ResackStatus" AS ENUM ('STARTED', 'FINISHED', 'CANCELLED');

CREATE TABLE "ResackJob" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "inputProductId" TEXT NOT NULL,
    "inputQty" INTEGER NOT NULL,
    "inputGrams" INTEGER NOT NULL,
    "inputValueMinor" INTEGER NOT NULL,
    "outputGrams" INTEGER,
    "lossGrams" INTEGER,
    "lossBp" INTEGER,
    "lossValueMinor" INTEGER,
    "varietyChange" BOOLEAN NOT NULL DEFAULT false,
    "openSack" BOOLEAN NOT NULL DEFAULT false,
    "status" "ResackStatus" NOT NULL DEFAULT 'STARTED',
    "kargadorId" TEXT,
    "approvalId" TEXT,
    "note" TEXT,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedById" TEXT,
    "finishedAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    CONSTRAINT "ResackJob_pkey" PRIMARY KEY ("id"),
    -- Weight can only be lost, never created; a finished job has its numbers.
    CONSTRAINT "ResackJob_sane" CHECK (
      "inputQty" > 0 AND "inputGrams" > 0 AND "inputValueMinor" >= 0
      AND ("outputGrams" IS NULL OR ("outputGrams" > 0 AND "outputGrams" <= "inputGrams"))
      AND ("lossGrams" IS NULL OR "lossGrams" = "inputGrams" - "outputGrams")
      AND ("status" <> 'FINISHED' OR ("outputGrams" IS NOT NULL AND "finishedAt" IS NOT NULL))
    )
);
CREATE UNIQUE INDEX "ResackJob_storeId_docNumber_key" ON "ResackJob"("storeId", "docNumber");
CREATE INDEX "ResackJob_storeId_status_locationId_idx" ON "ResackJob"("storeId", "status", "locationId");
CREATE INDEX "ResackJob_storeId_startedAt_idx" ON "ResackJob"("storeId", "startedAt");
ALTER TABLE "ResackJob" ADD CONSTRAINT "ResackJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResackJob" ADD CONSTRAINT "ResackJob_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResackJob" ADD CONSTRAINT "ResackJob_inputProductId_fkey" FOREIGN KEY ("inputProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResackJob" ADD CONSTRAINT "ResackJob_kargadorId_fkey" FOREIGN KEY ("kargadorId") REFERENCES "Kargador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ResackOutput" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "grams" INTEGER NOT NULL,
    "valueMinor" INTEGER NOT NULL,
    CONSTRAINT "ResackOutput_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResackOutput_positive" CHECK ("quantity" > 0 AND "grams" > 0 AND "valueMinor" >= 0)
);
CREATE INDEX "ResackOutput_storeId_jobId_idx" ON "ResackOutput"("storeId", "jobId");
ALTER TABLE "ResackOutput" ADD CONSTRAINT "ResackOutput_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ResackJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResackOutput" ADD CONSTRAINT "ResackOutput_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResackJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResackOutput" ENABLE ROW LEVEL SECURITY;
