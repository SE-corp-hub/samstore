-- N1: at most ONE open register shift per store, enforced at the database boundary
-- (a concurrent double-open loses on the unique index instead of creating two shifts).
CREATE UNIQUE INDEX "RegisterSession_one_open_per_store"
  ON "RegisterSession" ("storeId")
  WHERE "status" = 'OPEN';
