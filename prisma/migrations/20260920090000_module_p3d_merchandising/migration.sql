-- P3d: catalog merchandising — featured flag, free-form tags, and related/upsell relations.
-- Tenant-safe: ProductRelation carries storeId on every row and links only SAME-store
-- products via composite FKs to Product(storeId, id) (M3 pattern).

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ProductRelation" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "targetProductId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductRelation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductRelation_storeId_sourceProductId_targetProductId_kind_key" ON "ProductRelation"("storeId", "sourceProductId", "targetProductId", "kind");
CREATE INDEX "ProductRelation_storeId_sourceProductId_kind_idx" ON "ProductRelation"("storeId", "sourceProductId", "kind");

-- AddForeignKey (composite tenant-consistent, M3 pattern)
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_sourceProductId_fkey" FOREIGN KEY ("storeId", "sourceProductId") REFERENCES "Product"("storeId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_targetProductId_fkey" FOREIGN KEY ("storeId", "targetProductId") REFERENCES "Product"("storeId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;