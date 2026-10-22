# Nightly backup (free)

**Decision (22 Oct):** the shop database stays on the Free plan. A free nightly backup job on the Sam PC keeps the shop's data safe. **We do not go live without it running and checked.**

## What it does

- Every day at the time you choose, the PC saves a full copy of the shop database into the `backups` folder (a `.dump` file, for example `samstore-20261022-2130.dump`).
- It checks that the file can be read. If it cannot, it deletes it and tells you.
- It keeps the **last 14 days** plus **one backup per month for 6 months**, and deletes older ones.
- If you give it a second folder (Google Drive or a USB stick), it also copies each backup there. This is what saves you if the PC breaks. **Please set this.**
- It writes one line per run to `backups\backup-log.txt`. If a run fails it tries again after 5 minutes, then shows a message box and writes `backups\BACKUP-FAILED.txt`.
- Backups contain customer data. The `backups` folder is never uploaded to GitHub. Do not email or share the files.

## Set it up (once, about 10 minutes)

1. On the Sam PC, open the `extraricestore` folder.
2. Double-click **`setup-nightly-backup.bat`**.
3. Type the time (for example `21:30`; press Enter for 21:30). Choose a time when the PC is on and you are signed in.
4. Type the folder for the second copy (for example `G:\My Drive\samstore-backups`) or press Enter to skip. You can set it later in `go-live\backup-copy-folder.txt` (one line, the folder path).
5. It makes a first backup right away (a few minutes is normal). If that works, it schedules the daily job and says **DONE**. If it does not work, nothing is scheduled; tell Claude what it says.

Without questions: `setup-nightly-backup.bat 21:30 none` (the time, then the second-copy folder or `none`). Claude used this on 22 Oct with 21:30 and no second copy, so the second-copy folder is still to be set.

If the PC is off at the chosen time, the backup runs as soon as the PC is on again. A black window opens for a few minutes while it runs. Leave it open; it closes by itself.

You need the PostgreSQL command-line tools on this PC (they are already there if `npm run db:backup` worked before).

## Check it (30 seconds, once a week and before go-live)

Double-click **`backup-status.bat`**. It shows the newest backups, where the second copy goes, the last log lines, and **OK** or **WARNING**. A warning means the newest backup is more than 36 hours old or the last run failed.

Make a backup by hand at any time with **`backup-now.bat`**. Always do this just before changing the database (for example before applying migrations).

## Before go-live

- [ ] `setup-nightly-backup.bat` finished with DONE.
- [ ] `backup-status.bat` shows OK, and the second copy folder has the same file.
- [ ] A backup is restorable: the backup step already proves the file can be read (`pg_restore --list`). A full practice restore into an empty database is optional and can be done with Claude's help on a test database. Never restore over the shop database without the owner's explicit approval.

## Stop or change it

- Change the time or the folder: run `setup-nightly-backup.bat` again (it replaces the old schedule).
- Remove it: in Windows, search "Task Scheduler", find **Samstore nightly backup**, and delete it. Or run `schtasks /Delete /TN "Samstore nightly backup" /F`.

## Notes for Claude

- Code: `scripts/backup-nightly.mjs` (runs `scripts/backup-db.mjs`, then keeps/prunes, copies, logs, warns), `scripts/backup-keep.mjs` (which files may be deleted; tested in `scripts/backup-keep.test.mjs`).
- The database address is only in `.env` and is never printed. The log holds file names and sizes only.
- If the owner later wants backups that do not depend on the PC being on, the paid Supabase plan with daily backups is the simple upgrade.
