-- P2a: product variants + add-ons/modifiers. CartItem gains variant identity
-- (productId/ variantId / addonKey unique, addons price snapshot), OrderItem +
-- StockMovement gain variant fields for immutable snapshots and variant stock audit.

-- DropIndex
DROP INDEX "CartItem_cartId_productId_key";

-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "addonKey" TEXT,
ADD COLUMN     "addons" JSONB,
ADD COLUMN     "addonsTotalMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "variantId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "addons" JSONB,
ADD COLUMN     "variantId" TEXT,
ADD COLUMN     "variantName" TEXT;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "variantId" TEXT;

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "quantityOnHand" INTEGER NOT NULL DEFAULT 0,
    "quantityReserved" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAddon" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAddonOption" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "addonId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAddonOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductVariant_storeId_productId_idx" ON "ProductVariant"("storeId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_storeId_sku_key" ON "ProductVariant"("storeId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_storeId_id_key" ON "ProductVariant"("storeId", "id");

-- CreateIndex
CREATE INDEX "ProductAddon_storeId_productId_idx" ON "ProductAddon"("storeId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAddon_storeId_id_key" ON "ProductAddon"("storeId", "id");

-- CreateIndex
CREATE INDEX "ProductAddonOption_storeId_addonId_idx" ON "ProductAddonOption"("storeId", "addonId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAddonOption_storeId_id_key" ON "ProductAddonOption"("storeId", "id");

-- CreateIndex
CREATE INDEX "CartItem_storeId_idx" ON "CartItem"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_cartId_productId_variantId_addonKey_key" ON "CartItem"("cartId", "productId", "variantId", "addonKey");

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_storeId_productId_fkey" FOREIGN KEY ("storeId", "productId") REFERENCES "Product"("storeId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAddon" ADD CONSTRAINT "ProductAddon_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAddon" ADD CONSTRAINT "ProductAddon_storeId_productId_fkey" FOREIGN KEY ("storeId", "productId") REFERENCES "Product"("storeId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAddonOption" ADD CONSTRAINT "ProductAddonOption_storeId_addonId_fkey" FOREIGN KEY ("storeId", "addonId") REFERENCES "ProductAddon"("storeId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_storeId_variantId_fkey" FOREIGN KEY ("storeId", "variantId") REFERENCES "ProductVariant"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;