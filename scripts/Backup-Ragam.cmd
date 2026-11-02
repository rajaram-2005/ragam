@echo off
setlocal
cd /d "%~dp0.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Backup-Ragam.ps1"
if errorlevel 1 (
  echo Backup did not complete successfully. Keep the existing Docker volume unchanged.
) else (
  echo Backup task finished.
)
pause
