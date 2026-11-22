-- 2026-11-22 Resack: more than one rice going in. The job keeps its first input; the others are here.
-- Add-only: old resacks have no rows here and read exactly as before.
CREATE TABLE "ResackInput" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "grams" INTEGER NOT NULL,
    "valueMinor" INTEGER NOT NULL,
    CONSTRAINT "ResackInput_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResackInput_positive" CHECK ("quantity" > 0 AND "grams" > 0 AND "valueMinor" >= 0)
);
CREATE INDEX "ResackInput_storeId_jobId_idx" ON "ResackInput"("storeId", "jobId");
ALTER TABLE "ResackInput" ADD CONSTRAINT "ResackInput_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ResackJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResackInput" ADD CONSTRAINT "ResackInput_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResackInput" ENABLE ROW LEVEL SECURITY;
