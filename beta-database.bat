@echo off
REM Sets up the separate beta database. See scripts\beta-database.mjs
cd /d "%~dp0"
if not exist go-live mkdir go-live
echo.
echo BETA DATABASE SETUP
echo Use the NEW beta Supabase project (Connect, Direct, Connection string, Session pooler, port 5432).
echo.
node scripts\beta-database.mjs
echo.
pause
