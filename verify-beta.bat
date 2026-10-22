@echo off
REM Runs the FULL check (migrations, types, every database test) on the BETA database only.
REM The shop database is never touched and no backup is taken. See scripts\verify-beta.mjs
REM Stops the local dev servers first (start them again with start-dev.bat).
cd /d "%~dp0"
if not exist go-live mkdir go-live
call stop-dev.bat
git stash push -m "before-beta-verify-%DATE%-%TIME%"
git fetch origin release/rice-ops
git reset --hard origin/release/rice-ops
git log --oneline -3
call npm run db:generate
echo.
echo BETA CHECK: this runs on the BETA database only. The shop database is not touched.
echo First time: paste the beta database address when asked ^(Supabase beta project, Connect, Session pooler, port 5432^).
echo.
node scripts\verify-beta.mjs
echo.
echo Done. Copy the line that starts with VERIFY RESULT and tell Claude.
echo The full log is in verify-logs\latest-beta.txt
pause
