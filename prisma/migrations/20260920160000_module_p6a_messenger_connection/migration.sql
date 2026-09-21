-- P6a: Messenger page connection + messenger user identity mapping.

-- CreateTable
CREATE TABLE "MessengerPage" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "pageName" TEXT NOT NULL,
    "accessTokenHash" TEXT NOT NULL,
    "webhookVerifyTokenHash" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessengerPage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MessengerUser" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "psid" TEXT NOT NULL,
    "customerId" TEXT,
    "optedIn" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessengerUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessengerPage_storeId_key" ON "MessengerPage"("storeId");
CREATE UNIQUE INDEX "MessengerUser_storeId_psid_key" ON "MessengerUser"("storeId", "psid");
CREATE INDEX "MessengerUser_storeId_optedIn_idx" ON "MessengerUser"("storeId", "optedIn");

-- AddForeignKey
ALTER TABLE "MessengerPage" ADD CONSTRAINT "MessengerPage_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessengerUser" ADD CONSTRAINT "MessengerUser_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessengerUser" ADD CONSTRAINT "MessengerUser_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;