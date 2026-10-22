@echo off
REM Makes a backup right now, the same way the nightly job does. Result: backups\backup-log.txt
cd /d "%~dp0"
echo Backing up the shop database now. A few minutes is normal.
echo.
node scripts\backup-nightly.mjs
echo.
if errorlevel 1 (echo BACKUP DID NOT WORK. Read the message above, then tell Claude.) else (echo Backup done.)
pause
