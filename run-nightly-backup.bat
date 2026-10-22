@echo off
REM This is what the daily scheduled task runs. Please leave the window open; it closes by itself.
cd /d "%~dp0"
echo Samstore nightly backup is running. A few minutes is normal. Please leave this window open.
node scripts\backup-nightly.mjs
exit /b %errorlevel%
