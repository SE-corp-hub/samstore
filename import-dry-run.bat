@echo off
REM Checks the four lists in the go-live folder (products, customers, staff, kargadors). Nothing is saved.
REM How to fill them: docs\rice-ops\import-templates\README.md or go-live\HOW-TO-FILL-THE-LISTS.txt
cd /d "%~dp0"
echo Checking the lists in go-live. Nothing is saved.
echo.
call npm run rice:import -- --store sam-store > go-live\import-check.txt 2>&1
type go-live\import-check.txt
echo.
echo The same text is in go-live\import-check.txt. When it says 0 problems, tell Claude: lists are ready
if "%~1"=="" pause
