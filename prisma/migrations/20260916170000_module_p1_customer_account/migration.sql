-- P1.portal: customer saved addresses (tenant-scoped via StoreCustomer, PH hierarchy
-- codes + frozen name snapshots) + DPA ConsentRecord (RA 10173, append-only).

-- CreateTable
CREATE TABLE "StoreCustomerAddress" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "storeCustomerId" TEXT NOT NULL,
    "label" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "landmark" TEXT,
    "instructions" TEXT,
    "regionCode" TEXT,
    "provinceCode" TEXT,
    "cityCode" TEXT,
    "barangayCode" TEXT,
    "regionName" TEXT,
    "provinceName" TEXT,
    "cityName" TEXT,
    "barangayName" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreCustomerAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "version" TEXT,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreCustomerAddress_storeId_storeCustomerId_idx" ON "StoreCustomerAddress"("storeId", "storeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreCustomerAddress_storeId_id_key" ON "StoreCustomerAddress"("storeId", "id");

-- CreateIndex
CREATE INDEX "ConsentRecord_customerId_scope_idx" ON "ConsentRecord"("customerId", "scope");

-- AddForeignKey
ALTER TABLE "StoreCustomerAddress" ADD CONSTRAINT "StoreCustomerAddress_storeId_storeCustomerId_fkey" FOREIGN KEY ("storeId", "storeCustomerId") REFERENCES "StoreCustomer"("storeId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;