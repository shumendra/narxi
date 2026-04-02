@echo off
setlocal

set "ROOT=%~dp0.."
cd /d "%ROOT%"

set "PYTHON_EXE=c:\python314\python.exe"
if exist "%PYTHON_EXE%" goto :run

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  set "PYTHON_EXE=py -3"
  goto :run
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  set "PYTHON_EXE=python"
  goto :run
)

echo [ERROR] Python not found.
echo Install Python 3, then run this file again.
pause
exit /b 1

:run
echo.
echo [1/3] Installing Python packages...
%PYTHON_EXE% -m pip install -r scripts\requirements-receipt-worker.txt
if %ERRORLEVEL% neq 0 goto :fail

echo.
echo [2/3] Installing Playwright Chromium (can take time)...
%PYTHON_EXE% -m playwright install chromium
if %ERRORLEVEL% neq 0 goto :fail

echo.
echo [3/3] Setup complete.
echo You can now run: scripts\worker_run_windows.bat
echo.
pause
exit /b 0

:fail
echo.
echo [ERROR] Setup failed. Check messages above.
pause
exit /b 1
