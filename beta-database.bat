@echo off
REM Sets up the separate beta database. See scripts\beta-database.mjs
cd /d "%~dp0"
if not exist go-live mkdir go-live
echo.
echo BETA DATABASE SETUP (first time only)
echo To update a beta database already in use, run beta-database-update.bat instead:
echo this one also resets the sample store logins and puts the sample rice back.
echo Use the beta database address: Neon (Connect, pooling OFF) or a Supabase beta project (Session pooler, port 5432).
echo.
node scripts\beta-database.mjs
echo.
pause
