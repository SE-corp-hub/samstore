-- Read indexes for the screens the tablet opens all day (no data change).
-- OrderItem had none: every receipt, order, pre-order and the counter's most-sold count
-- read all of the store's sale lines.

-- CreateIndex
CREATE INDEX "OrderItem_storeId_orderId_idx" ON "OrderItem"("storeId", "orderId");

-- CreateIndex
CREATE INDEX "OrderItem_storeId_productId_idx" ON "OrderItem"("storeId", "productId");

-- CreateIndex
CREATE INDEX "Order_storeId_createdAt_idx" ON "Order"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_storeId_storeCustomerId_createdAt_idx" ON "Order"("storeId", "storeCustomerId", "createdAt");
