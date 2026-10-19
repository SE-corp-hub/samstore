-- A place added by counter staff on the spot is flagged so the owner can check it.
ALTER TABLE "Warehouse" ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;
