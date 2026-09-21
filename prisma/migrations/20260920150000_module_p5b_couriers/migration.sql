-- P5b: courier bookings + delivery events + COD remittance ledger.

-- CreateTable
CREATE TABLE "DeliveryBooking" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "courier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "trackingNumber" TEXT,
    "remoteId" TEXT,
    "codMinor" INTEGER NOT NULL DEFAULT 0,
    "remittedMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryBooking_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeliveryEvent" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourierRemittance" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "note" TEXT,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierRemittance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryBooking_storeId_createdAt_idx" ON "DeliveryBooking"("storeId", "createdAt");
CREATE INDEX "DeliveryEvent_storeId_bookingId_idx" ON "DeliveryEvent"("storeId", "bookingId");
CREATE INDEX "CourierRemittance_storeId_bookingId_idx" ON "CourierRemittance"("storeId", "bookingId");

-- AddForeignKey
ALTER TABLE "DeliveryBooking" ADD CONSTRAINT "DeliveryBooking_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryBooking" ADD CONSTRAINT "DeliveryBooking_orderId_fkey" FOREIGN KEY ("storeId", "orderId") REFERENCES "Order"("storeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryEvent" ADD CONSTRAINT "DeliveryEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "DeliveryBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourierRemittance" ADD CONSTRAINT "CourierRemittance_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "DeliveryBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;