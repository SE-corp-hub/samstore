-- P3h: new loyalty ledger entry types (welcome bonus / reversal / expiry).

-- AlterEnum
ALTER TYPE "LoyaltyEntryType" ADD VALUE 'WELCOME';
ALTER TYPE "LoyaltyEntryType" ADD VALUE 'REVERSE';
ALTER TYPE "LoyaltyEntryType" ADD VALUE 'EXPIRED';