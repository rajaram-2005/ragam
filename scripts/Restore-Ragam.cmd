@echo off
setlocal
cd /d "%~dp0.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restore-Ragam.ps1"
if errorlevel 1 (
  echo Restore did not complete. Follow the on-screen safety instructions and keep all archives.
) else (
  echo Restore task finished.
)
pause
