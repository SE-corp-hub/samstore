-- Rice Ops M10: weak signal. A phone queues a signed step while offline and sends it
-- when the signal returns; the same Idempotency-Key always gets the first answer, so a
-- step that reached the server before the signal dropped is never done twice.
-- Additive only.

SET lock_timeout = '20s';

CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL, -- sha256(user + store + route + the phone's key); the raw key is never stored
    "userId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS', -- IN_PROGRESS | DONE
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdempotencyRecord_keyHash_key" ON "IdempotencyRecord"("keyHash");
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");
ALTER TABLE "IdempotencyRecord" ENABLE ROW LEVEL SECURITY;
