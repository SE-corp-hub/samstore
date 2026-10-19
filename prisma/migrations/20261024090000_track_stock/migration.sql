-- Track stock on/off per product. Default on: nothing changes until someone switches a product off.
ALTER TABLE "Product" ADD COLUMN "trackStock" BOOLEAN NOT NULL DEFAULT true;
