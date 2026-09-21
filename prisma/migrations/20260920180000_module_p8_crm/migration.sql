-- P8: CRM — StoreCustomer tags + campaigns + idempotent recipients.

-- AlterTable
ALTER TABLE "StoreCustomer" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rule" JSONB NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "storeCustomerId" TEXT NOT NULL,
    "psid" TEXT,
    "sent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_storeId_name_key" ON "Campaign"("storeId", "name");
CREATE INDEX "Campaign_storeId_status_idx" ON "Campaign"("storeId", "status");
CREATE UNIQUE INDEX "CampaignRecipient_storeId_campaignId_storeCustomerId_key" ON "CampaignRecipient"("storeId", "campaignId", "storeCustomerId");
CREATE INDEX "CampaignRecipient_storeId_storeCustomerId_idx" ON "CampaignRecipient"("storeId", "storeCustomerId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;