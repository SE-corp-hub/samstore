@echo off
REM Rice Ops one-command check. Output: verify-logs\latest.txt
cd /d "%~dp0"
call npm run verify
echo.
echo Tapos na. Sabihin kay Claude: done
pause
