@echo off
REM Updates a beta database that is already in use: adds the new tables and fields only.
REM Logins, rice, prices and stock are not touched. See scripts\beta-database.mjs --fields-only
cd /d "%~dp0"
if not exist go-live mkdir go-live
echo.
echo BETA DATABASE UPDATE (adds new fields only, removes nothing)
echo Use the beta database address: Neon, Connect, pooling OFF.
echo.
node scripts\beta-database.mjs --fields-only
echo.
pause
