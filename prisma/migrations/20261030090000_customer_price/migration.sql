-- A special price per customer and product; beats the store/location price at sale time.
CREATE TABLE "CustomerPrice" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "storeCustomerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerPrice_storeId_storeCustomerId_productId_key" ON "CustomerPrice"("storeId", "storeCustomerId", "productId");
CREATE INDEX "CustomerPrice_storeId_storeCustomerId_idx" ON "CustomerPrice"("storeId", "storeCustomerId");
