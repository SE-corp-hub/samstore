-- v6 — user must-change-password flag + password reset audit trail.
-- ALTER TABLE
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PasswordResetHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL DEFAULT '',
    "resetBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PasswordResetHistory_userId_createdAt_idx" ON "PasswordResetHistory"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PasswordResetHistory" ADD CONSTRAINT "PasswordResetHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;