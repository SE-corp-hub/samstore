-- Rice Ops M7: agent orders — the agent's order waits (Naghihintay) until any staff at the
-- preferred store approves it (picks where the rice comes from) or declines it.
-- Additive only.

SET lock_timeout = '20s';

ALTER TABLE "Order" ADD COLUMN "agentUserId" TEXT;
ALTER TABLE "Order" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "Order" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "declineReason" TEXT;
CREATE INDEX "Order_storeId_agentUserId_createdAt_idx" ON "Order"("storeId", "agentUserId", "createdAt");
CREATE INDEX "Order_storeId_source_status_idx" ON "Order"("storeId", "source", "status");
