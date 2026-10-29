@echo off
REM One-time setup: makes a backup now to prove it works, then schedules one every day. Free.
REM   setup-nightly-backup.bat                 asks two questions
REM   setup-nightly-backup.bat 21:30 none      no questions (time, then a second-copy folder or none)
cd /d "%~dp0"
set AT=%~1
set COPYDIR=%~2
set QUIET=
if not "%~1"=="" set QUIET=1
echo.
echo ===== NIGHTLY BACKUP SETUP =====
echo This PC must be ON (and you signed in) at the time you choose. If it was off, the backup runs
echo as soon as the PC is on again. The last 14 backups plus one per month for 6 months are kept.
echo.
if defined QUIET goto start
set /p AT=What time each day? Use 24-hour time, for example 21:30. Press Enter for 21:30: 
if "%AT%"=="" set AT=21:30
echo.
echo A second copy keeps your data safe if this PC breaks. Type the folder where it should go
echo (for example a Google Drive folder or a USB stick such as G:\samstore-backups).
set /p COPYDIR=Folder for the second copy, or press Enter to skip: 
:start
if "%COPYDIR%"=="none" set COPYDIR=
if not exist go-live mkdir go-live
if not "%COPYDIR%"=="" >"go-live\backup-copy-folder.txt" echo %COPYDIR%
echo.
echo Making a first backup now to prove it works. A few minutes is normal...
node scripts\backup-nightly.mjs
if errorlevel 1 (
  echo.
  echo THE FIRST BACKUP DID NOT WORK, so nothing was scheduled. Read the message above, fix it, and run this again.
  if not defined QUIET pause
  exit /b 1
)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '\"%~dp0run-nightly-backup-hidden.vbs\"' -WorkingDirectory '%~dp0'; $t = New-ScheduledTaskTrigger -Daily -At '%AT%'; $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2); Register-ScheduledTask -TaskName 'Samstore nightly backup' -Action $a -Trigger $t -Settings $s -Description 'Backs up the shop database every day' -Force | Out-Null"
if errorlevel 1 (
  echo.
  echo The first backup worked, but the daily schedule could not be created. Tell Claude.
  if not defined QUIET pause
  exit /b 1
)
echo.
schtasks /Query /TN "Samstore nightly backup" /FO LIST | findstr /i "TaskName Next"
echo.
echo DONE. A backup will be made every day at %AT%. Check any time with backup-status.bat.
if not defined QUIET pause
