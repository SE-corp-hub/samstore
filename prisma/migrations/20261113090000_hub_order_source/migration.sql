-- Hub door: where an order from SE Corp Hub was taken. All three stay NULL for shop-link and counter orders.
ALTER TABLE "Order" ADD COLUMN "sourceChannel" TEXT;
ALTER TABLE "Order" ADD COLUMN "sourcePage" TEXT;
ALTER TABLE "Order" ADD COLUMN "externalRef" TEXT;
