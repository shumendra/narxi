@echo off
setlocal

set "TASK_NAME=NarxiReceiptWorkerHourly"

schtasks /query /tn "%TASK_NAME%" >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo Task not found: %TASK_NAME%
  echo Nothing to disable.
  pause
  exit /b 0
)

schtasks /delete /tn "%TASK_NAME%" /f
if %ERRORLEVEL% neq 0 (
  echo [ERROR] Failed to delete scheduled task: %TASK_NAME%
  echo Try running this file as Administrator.
  pause
  exit /b 1
)

echo Disabled scheduled task: %TASK_NAME%
echo Worker is now manual-only via scripts\worker_run_windows.bat
pause
exit /b 0
