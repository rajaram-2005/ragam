@echo off
setlocal
cd /d "%~dp0.."

docker info >nul 2>&1
if errorlevel 1 (
  echo Start Docker Desktop and wait until its local Engine is running, then try again.
  pause
  exit /b 1
)

docker compose -f compose.yaml down
if errorlevel 1 (
  echo Ragam could not be stopped. Review the Compose output above.
  pause
  exit /b 1
)

echo Ragam containers are stopped. Persistent named volumes were kept on this computer.
pause
