-- PIN lock: the owner picks screens that ask for a lock PIN, one list for the owner sign-in and one for staff.
-- { salt, hash, iterations, owner: string[], staff: string[], updatedAt } or NULL (no lock).
ALTER TABLE "StoreSettings" ADD COLUMN "featureLock" JSONB;
