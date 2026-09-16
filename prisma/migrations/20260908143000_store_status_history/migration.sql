-- CreateTable
CREATE TABLE "StoreStatusHistory" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreStatusHistory_storeId_createdAt_idx" ON "StoreStatusHistory"("storeId", "createdAt");

-- AddForeignKey
ALTER TABLE "StoreStatusHistory" ADD CONSTRAINT "StoreStatusHistory_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
