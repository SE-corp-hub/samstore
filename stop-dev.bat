@echo off
REM Stops the SAM STORE dev servers (API 4100, web 3000) so the full check can refresh the database client.
taskkill /F /T /FI "WINDOWTITLE eq SAM STORE*" >nul 2>&1
for %%P in (4100 3000) do for /f "tokens=5" %%A in ('netstat -ano ^| findstr :%%P ^| findstr LISTENING') do taskkill /F /T /PID %%A >nul 2>&1
echo Dev servers stopped. Start them again with start-dev.bat
timeout /t 3 >nul
