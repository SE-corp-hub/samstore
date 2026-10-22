-- Purchase orders: order from a supplier, receive against it on Stock in, pay the supplier.
ALTER TABLE "StockIn" ADD COLUMN "purchaseOrderId" TEXT;
ALTER TABLE "StockInLine" ADD COLUMN "poLineId" TEXT;

CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    "unitCostMinor" INTEGER NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "note" TEXT,
    "reversesId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseOrder_storeId_docNumber_key" ON "PurchaseOrder"("storeId", "docNumber");
CREATE INDEX "PurchaseOrder_storeId_status_idx" ON "PurchaseOrder"("storeId", "status");
CREATE INDEX "PurchaseOrder_storeId_supplierId_idx" ON "PurchaseOrder"("storeId", "supplierId");
CREATE INDEX "PurchaseOrderLine_storeId_orderId_idx" ON "PurchaseOrderLine"("storeId", "orderId");
CREATE UNIQUE INDEX "SupplierPayment_reversesId_key" ON "SupplierPayment"("reversesId");
CREATE UNIQUE INDEX "SupplierPayment_storeId_docNumber_key" ON "SupplierPayment"("storeId", "docNumber");
CREATE INDEX "SupplierPayment_storeId_supplierId_createdAt_idx" ON "SupplierPayment"("storeId", "supplierId", "createdAt");

ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
