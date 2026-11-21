-- 2026-11-21 "Where was it made": each new customer and item keeps the store it was made at, who made it
-- and the screen (POS, Pre-order, Credit, ...). Add-only columns; rows from before stay empty ("Unknown")
-- unless an old record proves where they came from (filled below).
ALTER TABLE "StoreCustomer" ADD COLUMN "addedAtId" TEXT, ADD COLUMN "addedById" TEXT, ADD COLUMN "addedVia" TEXT;
ALTER TABLE "Product" ADD COLUMN "addedAtId" TEXT, ADD COLUMN "addedVia" TEXT;
CREATE INDEX "StoreCustomer_storeId_addedAtId_idx" ON "StoreCustomer"("storeId", "addedAtId");
CREATE INDEX "Product_storeId_addedAtId_idx" ON "Product"("storeId", "addedAtId");

-- A counter "New item" with stock on hand: its first Stock in ("New item: <name>") was at the store it was made at.
UPDATE "Product" p SET "addedVia" = 'POS', "addedAtId" = s."locationId"
FROM (
  SELECT DISTINCT ON (l."productId") l."productId", d."locationId"
  FROM "StockInLine" l JOIN "StockIn" d ON d."id" = l."stockInId"
  WHERE d."note" LIKE 'New item: %'
  ORDER BY l."productId", d."createdAt" ASC
) s
WHERE p."id" = s."productId" AND p."sku" LIKE 'BAGO-%' AND p."addedVia" IS NULL;
-- Other counter items (pre-order or not counted): made at the counter, store not known.
UPDATE "Product" SET "addedVia" = 'COUNTER' WHERE "sku" LIKE 'BAGO-%' AND "addedVia" IS NULL;
-- Per-kilo items are made from their sack by "Also sell per kilo".
UPDATE "Product" SET "addedVia" = 'KILO' WHERE "kiloOfId" IS NOT NULL AND "addedVia" IS NULL;
-- Rice loaded from the Excel list.
UPDATE "Product" p SET "addedVia" = 'IMPORT'
WHERE p."addedVia" IS NULL AND EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."entityId" = p."id" AND a."action" = 'import.product_create');

-- Customers added on Credit (the audit row names who added them).
UPDATE "StoreCustomer" sc SET "addedVia" = 'CREDIT', "addedById" = a."actorId"
FROM (SELECT DISTINCT ON ("entityId") "entityId", "actorId" FROM "AuditLog" WHERE "action" = 'utang.customer_add' ORDER BY "entityId", "createdAt" ASC) a
WHERE sc."id" = a."entityId" AND sc."addedVia" IS NULL;
-- Customers with an online shop account signed up themselves.
UPDATE "StoreCustomer" sc SET "addedVia" = 'ONLINE'
FROM "Customer" c WHERE c."id" = sc."customerId" AND c."passwordHash" IS NOT NULL AND sc."addedVia" IS NULL;
