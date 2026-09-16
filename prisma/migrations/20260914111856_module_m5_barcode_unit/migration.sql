-- M5: product barcode + unit + soldByWeight (integer-only this module; decimal qty deferred)

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "soldByWeight" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unit" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Product_storeId_barcode_key" ON "Product"("storeId", "barcode");