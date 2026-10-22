-- Count: the owner's "Needs a look" review of a posted count (looked at or not, with an optional note). Additive only.
ALTER TABLE "StockCount" ADD COLUMN "lookStatus" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN "lookNote" TEXT,
ADD COLUMN "reviewedById" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3);
