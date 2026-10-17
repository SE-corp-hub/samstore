@echo off
REM Starts SAM STORE dev servers: API (port 4100) and web (port 3000)
cd /d "%~dp0"
REM The browser reaches the API through the web server (/backend), so phones and
REM other PCs on the same Wi-Fi can open http://<this PC>:3000 too.
set "NEXT_PUBLIC_API_URL=/backend"
start "SAM STORE API (4100)" cmd /k npm run dev:api
start "SAM STORE WEB (3000)" /d "%~dp0apps\web" cmd /k npx next dev -p 3000
