@echo off
REM Read-only report on the shop database: which migrations are still to apply, and which locations exist or would be created.
REM It changes nothing. Result: go-live\shop-state.txt (no passwords in it).
cd /d "%~dp0"
if not exist go-live mkdir go-live
set OUT=go-live\shop-state.txt
echo ===== SHOP DATABASE REPORT - read only, nothing is changed ===== > %OUT%
echo. >> %OUT%
echo --- migrations --- >> %OUT%
call npx prisma migrate status >> %OUT% 2>&1
echo. >> %OUT%
echo --- locations: dry run --- >> %OUT%
call npx tsx scripts/setup-locations.ts --store sam-store >> %OUT% 2>&1
echo. >> %OUT%
echo FINISHED >> %OUT%
type %OUT%
echo.
echo Done. The same text is in go-live\shop-state.txt. Tell Claude: done
if "%~1"=="" pause
