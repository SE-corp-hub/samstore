-- Damage at a consignment store the owner charges to it: the write-off it came from. Additive only.
ALTER TABLE "StorePayableEntry" ADD COLUMN "writeOffId" TEXT;
CREATE UNIQUE INDEX "StorePayableEntry_writeOffId_key" ON "StorePayableEntry"("writeOffId");
