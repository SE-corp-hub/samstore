-- Sell rice per kilo (2026-11-20). Add-only.
-- Warehouse.sellPerKilo: the store sells per kilo as well as per sack (off = sacks only, as before).
-- Product.kiloOfId: a kilo item's sack rice (the sack opened into it).

ALTER TABLE "Warehouse" ADD COLUMN "sellPerKilo" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Product" ADD COLUMN "kiloOfId" TEXT;
CREATE INDEX "Product_storeId_kiloOfId_idx" ON "Product"("storeId", "kiloOfId");
