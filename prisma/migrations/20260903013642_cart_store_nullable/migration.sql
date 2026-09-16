-- DropForeignKey
ALTER TABLE "Cart" DROP CONSTRAINT "Cart_storeId_fkey";

-- AlterTable
ALTER TABLE "Cart" ALTER COLUMN "storeId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
