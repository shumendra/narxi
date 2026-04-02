@echo off
setlocal

set "ROOT=%~dp0.."
cd /d "%ROOT%"

if not exist ".env" (
  echo [ERROR] .env file not found in project root.
  echo Create .env with SUPABASE_URL and SUPABASE_KEY first.
  pause
  exit /b 1
)

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
pause
exit /b 1

:run
echo Running receipt worker...
%PYTHON_EXE% scripts\process_receipts.py

echo.
echo Worker finished.
pause
