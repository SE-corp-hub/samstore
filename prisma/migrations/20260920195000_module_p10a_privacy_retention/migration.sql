-- P10a: configurable privacy retention window. 0 = no automated purge.

ALTER TABLE "StoreSettings" ADD COLUMN "privacyRetentionDays" INTEGER NOT NULL DEFAULT 0;
