-- A consignment store sells the main store's rice: every sale charges the main store's cost to its Store payable.
ALTER TABLE "Warehouse" ADD COLUMN "consignment" BOOLEAN NOT NULL DEFAULT false;
