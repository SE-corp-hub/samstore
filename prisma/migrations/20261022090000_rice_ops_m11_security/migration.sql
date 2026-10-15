-- Rice Ops M11 — security bundle.

-- Password login lockout (same rule as the PIN: 5 wrong → locked 15 minutes),
-- kept in the database so it holds across restarts and API instances.
ALTER TABLE "User" ADD COLUMN "loginFailedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "loginLockedUntil" TIMESTAMP(3);

-- Order numbers are unique per store, not across all stores: two stores that pick
-- the same prefix (e.g. "RICE") must both be able to take orders.
DROP INDEX "Order_orderNumber_key";
CREATE UNIQUE INDEX "Order_storeId_orderNumber_key" ON "Order"("storeId", "orderNumber");
