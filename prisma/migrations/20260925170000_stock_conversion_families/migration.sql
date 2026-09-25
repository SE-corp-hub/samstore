-- Restrict conversions to explicit material families and preserve the family on each audit record.
ALTER TABLE "Product"
  ADD COLUMN "stockConversionFamily" TEXT;

ALTER TABLE "StockConversion"
  ADD COLUMN "conversionFamily" TEXT NOT NULL DEFAULT '';

ALTER TABLE "StockConversion"
  ALTER COLUMN "conversionFamily" DROP DEFAULT;
