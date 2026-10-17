@echo off
cd /d "%~dp0"
echo === Branch ===
git branch --show-current
echo.
echo === Files to commit ===
git status --short
echo.
git add -A
git commit -m "Mobile UX: stay signed in, staff bottom bar and Home, offline queue keeps sales on 401/5xx" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01B3f9vZq8PR4wy16Dqu1Mkw"
if errorlevel 1 (echo COMMIT FAILED & pause & exit /b 1)
git push
if errorlevel 1 (echo PUSH FAILED & pause & exit /b 1)
echo.
echo DONE: committed and pushed.
git log -1 --oneline
pause
