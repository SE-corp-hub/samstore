-- P3g: Website→Messenger bridge — store connection state (sends stay suppressed).
-- The connected flag + page id are the admin's recorded intent; real credentials
-- live in env vars (never the DB), per the master prompt.

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN "messengerConnected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "messengerPageId" TEXT;