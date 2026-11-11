-- Product pictures for POS / Pre-order / Products: one small picture per product.
ALTER TABLE "Product" ADD COLUMN "photoKey" TEXT;

CREATE TABLE "ProductPhoto" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductPhoto_storeId_productId_idx" ON "ProductPhoto"("storeId", "productId");

ALTER TABLE "ProductPhoto" ENABLE ROW LEVEL SECURITY;
