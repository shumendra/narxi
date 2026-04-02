@echo off
setlocal

set "ROOT=%~dp0.."
cd /d "%ROOT%"

set "TASK_NAME=NarxiReceiptWorkerHourly"
set "RUN_SCRIPT=%ROOT%\scripts\worker_run_windows.bat"

schtasks /query /tn "%TASK_NAME%" >nul 2>nul
if %ERRORLEVEL%==0 (
  echo Task already exists: %TASK_NAME%
  echo Updating to run hourly...
  schtasks /delete /tn "%TASK_NAME%" /f >nul
)

schtasks /create /tn "%TASK_NAME%" /sc hourly /mo 1 /tr "\"%RUN_SCRIPT%\"" /f
if %ERRORLEVEL% neq 0 (
  echo [ERROR] Failed to create scheduled task.
  echo Try running this file as Administrator.
  pause
  exit /b 1
)

echo Scheduled task created: %TASK_NAME%
echo It will run hourly using worker_run_windows.bat
pause
exit /b 0
