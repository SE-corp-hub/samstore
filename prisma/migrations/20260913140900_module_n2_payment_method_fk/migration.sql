-- N2 follow-up: align PaymentMethod with the tenant-consistency convention used by
-- every other store-owned table (composite (storeId, id) unique + cascade from Store).
ALTER TABLE "PaymentMethod" DROP CONSTRAINT "PaymentMethod_storeId_fkey";

CREATE UNIQUE INDEX "PaymentMethod_storeId_id_key" ON "PaymentMethod"("storeId", "id");

ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
