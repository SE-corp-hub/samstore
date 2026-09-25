-- Make conversion retries safe even if the client misses the first response.
ALTER TABLE "StockConversion"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "sourceBalanceAfter" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "outputBalanceAfter" INTEGER NOT NULL DEFAULT 0;

UPDATE "StockConversion"
SET "idempotencyKey" = 'legacy_' || "id"
WHERE "idempotencyKey" IS NULL;

ALTER TABLE "StockConversion"
  ALTER COLUMN "idempotencyKey" SET NOT NULL;

CREATE UNIQUE INDEX "StockConversion_idempotencyKey_key" ON "StockConversion"("idempotencyKey");
