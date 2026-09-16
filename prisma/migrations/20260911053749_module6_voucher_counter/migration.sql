-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "usedCount" INTEGER NOT NULL DEFAULT 0;


-- Backfill: existing redemptions become the starting counter.
UPDATE "Voucher" SET "usedCount" = t.n FROM (
  SELECT "voucherId", count(*) AS n FROM "VoucherRedemption" WHERE "orderId" IS NOT NULL GROUP BY 1
) t WHERE "Voucher"."id" = t."voucherId";
