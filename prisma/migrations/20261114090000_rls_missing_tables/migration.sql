-- Seven newer tables were made without row-level security, so the guard test
-- (persistence/row-level-security.test.ts) has been red since they were added.
-- The app's own database role owns the tables and is not limited by this; it only
-- closes the public data API, the same as every other table.
SET lock_timeout = '20s';

ALTER TABLE "CustomerPrice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PriceHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StorePayableEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoreSalesReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierPayment" ENABLE ROW LEVEL SECURITY;
