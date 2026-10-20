-- New items added at the counter now go straight into Products (no owner review).
-- Items that were still waiting for review become normal products, and their open approval requests are closed.
UPDATE "ApprovalRequest" SET "status" = 'APPROVED', "decidedAt" = now(), "decisionNote" = 'No longer needs review'
WHERE "kind" = 'MANUAL_ITEM' AND "status" = 'PENDING';
UPDATE "Product" SET "reviewStatus" = 'ACTIVE' WHERE "reviewStatus" = 'FOR_REVIEW';
