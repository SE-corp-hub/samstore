@echo off
REM Tells the backup which database is the shop. Saves the address in go-live\backup-database-url.txt
REM (git ignores it). Delete that file to go back to the address in .env.
cd /d "%~dp0"
setlocal EnableDelayedExpansion
if not exist go-live mkdir go-live
echo.
echo Paste the shop database address (Neon: Connect, pooling OFF) and press Enter.
echo It starts with postgresql://
set /p URL=Address:
if "!URL!"=="" (echo Nothing saved.& pause & exit /b 1)
>"go-live\backup-database-url.txt" echo !URL!
cls
echo Saved. Making a backup now to check it works...
echo.
node scripts\backup-nightly.mjs
echo.
if errorlevel 1 (echo BACKUP DID NOT WORK. Read the message above, then tell Claude.) else (echo Backup done. The nightly backup now uses this database.)
pause
