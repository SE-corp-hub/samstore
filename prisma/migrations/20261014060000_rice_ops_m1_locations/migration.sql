-- Rice Ops M1 — locations, location prices, one stock row per product per location.
--
-- 1. A Warehouse row becomes a stock LOCATION (STORE counter or bulk WAREHOUSE)
--    with a short code, an address and an active flag.
-- 2. Every store that holds stock gets a default location; legacy location-less
--    stock rows AND their product-level ledger rows move onto it together, so the
--    on-hand reconciliation (balance == sum of movements per row) is unchanged.
-- 3. Duplicate stock rows for the same product at the same location are merged
--    (quantities summed — the ledger already counts both), then a unique key
--    stops them from coming back.
-- 4. StockMovement gains documentType/documentId so every move traces to its document.
-- 5. LocationPrice: a location's own selling price (cost stays one per product).
-- Data-only steps are idempotent; re-running finds nothing left to fix.

-- 1 ───────────────────────────────────────────────────────────────────────────
CREATE TYPE "LocationType" AS ENUM ('STORE', 'WAREHOUSE');

ALTER TABLE "Warehouse"
  ADD COLUMN "type" "LocationType" NOT NULL DEFAULT 'STORE',
  ADD COLUMN "code" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX "Warehouse_storeId_code_key" ON "Warehouse"("storeId", "code");

-- 2 ───────────────────────────────────────────────────────────────────────────
-- 2a. Stores that have locations but no default: the oldest becomes the default.
UPDATE "Warehouse" w
SET "isDefault" = true, "updatedAt" = now()
WHERE w.id IN (
  SELECT DISTINCT ON ("storeId") id
  FROM "Warehouse"
  WHERE "storeId" NOT IN (SELECT "storeId" FROM "Warehouse" WHERE "isDefault")
  ORDER BY "storeId", "createdAt", id
);

-- 2b. Stores with location-less stock and no location at all get a "Main" default.
INSERT INTO "Warehouse" ("id", "storeId", "name", "isDefault", "type", "isActive", "createdAt", "updatedAt")
SELECT 'loc_' || md5(s."storeId" || clock_timestamp()::text), s."storeId", 'Main', true, 'STORE', true, now(), now()
FROM (
  SELECT DISTINCT "storeId" FROM "StockLevel" WHERE "warehouseId" IS NULL
  UNION
  SELECT DISTINCT "storeId" FROM "StockMovement" WHERE "warehouseId" IS NULL AND "variantId" IS NULL
) s
WHERE NOT EXISTS (SELECT 1 FROM "Warehouse" w WHERE w."storeId" = s."storeId");

-- 2c. Location-less stock rows → the store's default location.
UPDATE "StockLevel" l
SET "warehouseId" = w.id
FROM "Warehouse" w
WHERE l."warehouseId" IS NULL AND w."storeId" = l."storeId" AND w."isDefault";

-- 2d. Their product-level ledger rows follow them (variant rows have no location).
UPDATE "StockMovement" m
SET "warehouseId" = w.id
FROM "Warehouse" w
WHERE m."warehouseId" IS NULL AND m."variantId" IS NULL AND w."storeId" = m."storeId" AND w."isDefault";

-- 3 ───────────────────────────────────────────────────────────────────────────
-- Merge duplicates: the lowest id keeps the summed quantities.
CREATE TEMP TABLE "_m1_dupes" AS
SELECT l.id AS "dropId", k."keepId"
FROM "StockLevel" l
JOIN (
  SELECT "storeId", "productId", "warehouseId", min(id) AS "keepId"
  FROM "StockLevel"
  WHERE "warehouseId" IS NOT NULL
  GROUP BY "storeId", "productId", "warehouseId"
  HAVING count(*) > 1
) k ON k."storeId" = l."storeId" AND k."productId" = l."productId" AND k."warehouseId" = l."warehouseId"
WHERE l.id <> k."keepId";

UPDATE "StockLevel" keep
SET "quantityOnHand"   = keep."quantityOnHand"   + d."onHand",
    "quantityReserved" = keep."quantityReserved" + d."reserved",
    "reorderThreshold" = GREATEST(keep."reorderThreshold", d."threshold"),
    "updatedAt"        = now()
FROM (
  SELECT x."keepId",
         sum(l."quantityOnHand")   AS "onHand",
         sum(l."quantityReserved") AS "reserved",
         max(l."reorderThreshold") AS "threshold"
  FROM "_m1_dupes" x JOIN "StockLevel" l ON l.id = x."dropId"
  GROUP BY x."keepId"
) d
WHERE keep.id = d."keepId";

UPDATE "Product" p
SET "stockLevelId" = x."keepId"
FROM "_m1_dupes" x
WHERE p."stockLevelId" = x."dropId";

DELETE FROM "StockLevel" WHERE id IN (SELECT "dropId" FROM "_m1_dupes");
DROP TABLE "_m1_dupes";

CREATE UNIQUE INDEX "StockLevel_storeId_productId_warehouseId_key"
  ON "StockLevel"("storeId", "productId", "warehouseId");

-- 4 ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "StockMovement"
  ADD COLUMN "documentType" TEXT,
  ADD COLUMN "documentId" TEXT;

CREATE INDEX "StockMovement_storeId_documentType_documentId_idx"
  ON "StockMovement"("storeId", "documentType", "documentId");

-- 5 ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "LocationPrice" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LocationPrice_storeId_productId_warehouseId_key"
  ON "LocationPrice"("storeId", "productId", "warehouseId");
CREATE INDEX "LocationPrice_storeId_warehouseId_idx" ON "LocationPrice"("storeId", "warehouseId");

ALTER TABLE "LocationPrice" ADD CONSTRAINT "LocationPrice_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LocationPrice" ADD CONSTRAINT "LocationPrice_storeId_productId_fkey"
  FOREIGN KEY ("storeId", "productId") REFERENCES "Product"("storeId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LocationPrice" ADD CONSTRAINT "LocationPrice_warehouseId_fkey"
  FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same lock-down as every other public table (see 20261005090000_lock_down_public_schema).
ALTER TABLE "LocationPrice" ENABLE ROW LEVEL SECURITY;
