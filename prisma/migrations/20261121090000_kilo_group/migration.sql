-- Sell per kilo: every kilo item made by "Also sell per kilo" goes in the store's "1 kg" group
-- (Products → Group), so kilo rice shows together on POS. Data only: makes the group where a store
-- has kilo items and none yet (an owner's own "1kg" / "1 kg" is used), then moves those items in.
INSERT INTO "Category" ("id", "storeId", "name", "slug", "sortOrder", "isActive", "createdAt", "updatedAt")
SELECT 'kilo' || substr(md5(s."storeId"), 1, 21), s."storeId", '1 kg', '1-kg', 0, true, now(), now()
FROM (SELECT DISTINCT "storeId" FROM "Product" WHERE "kiloOfId" IS NOT NULL) s
WHERE NOT EXISTS (SELECT 1 FROM "Category" c WHERE c."storeId" = s."storeId" AND c."slug" IN ('1-kg', '1kg'));

UPDATE "Category" SET "isActive" = true, "updatedAt" = now()
WHERE "slug" IN ('1-kg', '1kg') AND "isActive" = false
  AND "storeId" IN (SELECT DISTINCT "storeId" FROM "Product" WHERE "kiloOfId" IS NOT NULL);

UPDATE "Product" p
SET "categoryId" = (
  SELECT c."id" FROM "Category" c
  WHERE c."storeId" = p."storeId" AND c."slug" IN ('1-kg', '1kg')
  ORDER BY c."createdAt" ASC LIMIT 1
), "updatedAt" = now()
WHERE p."kiloOfId" IS NOT NULL;
