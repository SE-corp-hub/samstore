-- A customer created on credit has no limit by default; the owner can set one later.
ALTER TABLE "StoreCustomer" ADD COLUMN "creditUnlimited" BOOLEAN NOT NULL DEFAULT false;
