-- Counter price override audit trail: staff may sell a POS/pre-order line at a
-- price that differs from the catalog (bounded + reasoned). The catalog price is
-- still stored on the product; these columns record the deviation, who made it
-- and why, so a receipt or a later audit can explain the price.
ALTER TABLE "OrderItem" ADD COLUMN "priceOverridden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OrderItem" ADD COLUMN "priceOverrideReason" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "priceOverriddenById" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "priceOverriddenAt" TIMESTAMP(3);
ALTER TABLE "OrderItem" ADD COLUMN "catalogUnitPriceMinor" INTEGER;
