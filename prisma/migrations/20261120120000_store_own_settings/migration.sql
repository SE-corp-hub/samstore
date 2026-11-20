-- Each store's own settings ("This store" in Settings). Add-only: three empty columns.
-- Empty (NULL) = follow the business setting in StoreSettings, so nothing changes until a store sets its own.

ALTER TABLE "Warehouse"
  ADD COLUMN "dayOpenClose" BOOLEAN,
  ADD COLUMN "requireOpenShift" BOOLEAN,
  ADD COLUMN "hidePricePreOrder" BOOLEAN;
