-- 2026-11-23: the owner's switch "Managers have full access to Products" (off = as before). Add-only.
ALTER TABLE "StoreSettings" ADD COLUMN "managersFullProducts" BOOLEAN NOT NULL DEFAULT false;
