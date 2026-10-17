@echo off
REM Fast check (about 1 minute): types and the tests that do not use the database. Output: verify-logs\latest.txt
cd /d "%~dp0"
call node scripts/verify.mjs --quick
echo.
echo Done. Tell Claude: done
pause
