@echo off
REM Soft launch: removes the TEST sales, orders, money and stock of the TEST Bigasan store.
REM Keeps locations, rice and prices, customers, logins and settings. Shows the list and asks first.
title Clear the test data
cd /d "%~dp0"
if not exist go-live mkdir go-live
echo.
echo CLEAR THE TEST DATA (shows what it would remove, then asks you to type CLEAR)
echo.
node scripts\clear-test-data.mjs
echo.
pause
