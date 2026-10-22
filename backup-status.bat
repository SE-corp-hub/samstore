@echo off
REM Shows the latest backups and says if one is overdue.
cd /d "%~dp0"
node scripts\backup-nightly.mjs --status
echo.
pause
