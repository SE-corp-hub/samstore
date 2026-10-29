@echo off
REM The daily scheduled task runs this with no window, through run-nightly-backup-hidden.vbs.
cd /d "%~dp0"
echo Samstore nightly backup is running. A few minutes is normal. Please leave this window open.
node scripts\backup-nightly.mjs
exit /b %errorlevel%
