-- Online checkout RESERVES stock; fulfilment CONSUMES the reservation and
-- cancellation RELEASES it. The guarded claim column makes settlement idempotent
-- and concurrency-safe (one winner per order).
CREATE TYPE "OrderStockDisposition" AS ENUM ('CONSUMED', 'RELEASED');

ALTER TABLE "Order" ADD COLUMN "stockDisposition" "OrderStockDisposition";
