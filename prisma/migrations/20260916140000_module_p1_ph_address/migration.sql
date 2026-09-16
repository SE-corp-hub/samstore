-- P1: PH address reference hierarchy (Region → Province → City/Municipality → Barangay)
-- Platform reference data, NOT store-owned. Seed ships a curated subset (Metro Manila +
-- demo provinces); full PSGC dataset PENDING. Order rows snapshot the frozen NAMES.
--
-- Also heals pre-existing drift: schema.prisma declares User.email optional (A1 phone-first
-- identity) but the applied A1 migration never dropped NOT NULL — a latent bug for
-- phone-only registrations. DROP NOT NULL is always safe.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryBarangayCode" TEXT,
ADD COLUMN     "deliveryBarangayName" TEXT,
ADD COLUMN     "deliveryCityCode" TEXT,
ADD COLUMN     "deliveryCityName" TEXT,
ADD COLUMN     "deliveryProvinceCode" TEXT,
ADD COLUMN     "deliveryProvinceName" TEXT,
ADD COLUMN     "deliveryRegionCode" TEXT,
ADD COLUMN     "deliveryRegionName" TEXT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PhRegion" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PhRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhProvince" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "PhProvince_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhCity" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "provinceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,

    CONSTRAINT "PhCity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhBarangay" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "PhBarangay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhRegion_code_key" ON "PhRegion"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PhProvince_code_key" ON "PhProvince"("code");

-- CreateIndex
CREATE INDEX "PhProvince_regionId_idx" ON "PhProvince"("regionId");

-- CreateIndex
CREATE UNIQUE INDEX "PhCity_code_key" ON "PhCity"("code");

-- CreateIndex
CREATE INDEX "PhCity_provinceId_idx" ON "PhCity"("provinceId");

-- CreateIndex
CREATE UNIQUE INDEX "PhBarangay_code_key" ON "PhBarangay"("code");

-- CreateIndex
CREATE INDEX "PhBarangay_cityId_idx" ON "PhBarangay"("cityId");

-- AddForeignKey
ALTER TABLE "PhProvince" ADD CONSTRAINT "PhProvince_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "PhRegion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhCity" ADD CONSTRAINT "PhCity_provinceId_fkey" FOREIGN KEY ("provinceId") REFERENCES "PhProvince"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhBarangay" ADD CONSTRAINT "PhBarangay_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "PhCity"("id") ON DELETE CASCADE ON UPDATE CASCADE;