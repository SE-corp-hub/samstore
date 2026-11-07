-- A shortage the owner records as sold to walk-ins keeps the sale it became, so it is sold once.
ALTER TABLE "StockCountLine" ADD COLUMN "walkInOrderId" TEXT;
