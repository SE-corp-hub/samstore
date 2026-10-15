-- Rice Ops M6: utang and text messages — over-limit approval, Bayad sa utang at any
-- store, utang texts (mock provider until the SMS account is approved), reminders.
-- Additive only.

SET lock_timeout = '20s';

ALTER TABLE "StoreSettings" ADD COLUMN "utangSmsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StoreSettings" ADD COLUMN "utangMonthlyReminder" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StoreSettings" ADD COLUMN "utangOverdueReminder" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StoreSettings" ADD COLUMN "utangOverdueDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "StoreSettings" ADD COLUMN "smsSenderName" TEXT;

-- A Bayad sa utang belongs to the location that took the money.
ALTER TABLE "Payment" ADD COLUMN "locationId" TEXT;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditEntry" ADD COLUMN "paymentId" TEXT;

CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "SmsMessage" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "storeCustomerId" TEXT,
    "phone" TEXT,
    "template" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "documentType" TEXT,
    "documentId" TEXT,
    "periodKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SmsMessage_storeId_createdAt_idx" ON "SmsMessage"("storeId", "createdAt");
CREATE INDEX "SmsMessage_storeId_storeCustomerId_createdAt_idx" ON "SmsMessage"("storeId", "storeCustomerId", "createdAt");
CREATE INDEX "SmsMessage_storeId_status_idx" ON "SmsMessage"("storeId", "status");
-- One reminder per customer per period (monthly / weekly overdue).
CREATE UNIQUE INDEX "SmsMessage_storeId_storeCustomerId_template_periodKey_key" ON "SmsMessage"("storeId", "storeCustomerId", "template", "periodKey");
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmsMessage" ADD CONSTRAINT "SmsMessage_storeCustomerId_fkey" FOREIGN KEY ("storeCustomerId") REFERENCES "StoreCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmsMessage" ENABLE ROW LEVEL SECURITY;
