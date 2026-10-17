@echo off
REM Gives the demo accounts (...@samstore.test) new random passwords. New passwords: go-live\demo-logins.txt
cd /d "%~dp0"
if not exist verify-logs mkdir verify-logs
call npx tsx scripts/lock-demo-accounts.ts > verify-logs\lock-demo-accounts.txt 2>&1
type verify-logs\lock-demo-accounts.txt
echo.
echo Tapos na. Sabihin kay Claude: done
pause
