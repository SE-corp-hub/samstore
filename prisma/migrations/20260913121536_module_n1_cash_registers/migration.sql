-- CreateEnum
CREATE TYPE "RegisterStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RegisterSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('FLOAT', 'CASH_IN', 'CASH_OUT', 'REFUND');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "registerSessionId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "registerSessionId" TEXT;

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "requireOpenShift" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Register" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Main counter',
    "status" "RegisterStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Register_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegisterSession" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "registerId" TEXT NOT NULL,
    "status" "RegisterSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openedBy" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloatMinor" INTEGER NOT NULL DEFAULT 0,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "countedMinor" INTEGER,
    "expectedMinor" INTEGER,
    "varianceMinor" INTEGER,
    "notes" TEXT,

    CONSTRAINT "RegisterSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Register_storeId_idx" ON "Register"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Register_storeId_id_key" ON "Register"("storeId", "id");

-- CreateIndex
CREATE INDEX "RegisterSession_storeId_status_idx" ON "RegisterSession"("storeId", "status");

-- CreateIndex
CREATE INDEX "RegisterSession_storeId_openedAt_idx" ON "RegisterSession"("storeId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RegisterSession_storeId_id_key" ON "RegisterSession"("storeId", "id");

-- CreateIndex
CREATE INDEX "CashMovement_storeId_sessionId_createdAt_idx" ON "CashMovement"("storeId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_registerSessionId_idx" ON "Payment"("registerSessionId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_registerSessionId_fkey" FOREIGN KEY ("registerSessionId") REFERENCES "RegisterSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Register" ADD CONSTRAINT "Register_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterSession" ADD CONSTRAINT "RegisterSession_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisterSession" ADD CONSTRAINT "RegisterSession_storeId_registerId_fkey" FOREIGN KEY ("storeId", "registerId") REFERENCES "Register"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_storeId_sessionId_fkey" FOREIGN KEY ("storeId", "sessionId") REFERENCES "RegisterSession"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_registerSessionId_fkey" FOREIGN KEY ("registerSessionId") REFERENCES "RegisterSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

