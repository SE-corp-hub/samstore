-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'COMPLETED';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'online';
