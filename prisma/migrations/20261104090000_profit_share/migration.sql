-- Profit share: the move a share came from. Additive only.
ALTER TABLE "StorePayableEntry" ADD COLUMN "transferId" TEXT;
