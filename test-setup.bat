@echo off
REM Makes (or refreshes) the separate TEST store for hands-on testing. Logins: go-live\test-logins.txt
cd /d "%~dp0"
if not exist verify-logs mkdir verify-logs
call npx tsx scripts/test-setup.ts > verify-logs\test-setup.txt 2>&1
type verify-logs\test-setup.txt
echo.
echo Tapos na. Sabihin kay Claude: done
pause
