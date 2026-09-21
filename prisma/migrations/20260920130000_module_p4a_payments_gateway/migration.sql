-- P4a: online payments — gateway sessions, proof upload, received/reviewed/refunded
-- lifecycle on Order.paymentStatus + Payment.gateway fields + append-only history.

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'RECEIVED';
ALTER TYPE "PaymentStatus" ADD VALUE 'REVIEWED';
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUNDED';
ALTER TYPE "PaymentStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "gateway" TEXT,
ADD COLUMN "checkoutSessionId" TEXT,
ADD COLUMN "checkoutUrl" TEXT,
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "proofData" TEXT,
ADD COLUMN "proofMime" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewedBy" TEXT;

-- CreateTable
CREATE TABLE "PaymentStatusHistory" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT,
    "actorType" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentStatusHistory_storeId_orderId_createdAt_idx" ON "PaymentStatusHistory"("storeId", "orderId", "createdAt");
CREATE INDEX "PaymentStatusHistory_storeId_paymentId_idx" ON "PaymentStatusHistory"("storeId", "paymentId");

-- AddForeignKey
ALTER TABLE "PaymentStatusHistory" ADD CONSTRAINT "PaymentStatusHistory_orderId_fkey" FOREIGN KEY ("storeId", "orderId") REFERENCES "Order"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentStatusHistory" ADD CONSTRAINT "PaymentStatusHistory_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;