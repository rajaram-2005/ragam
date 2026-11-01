@echo off
setlocal
cd /d "%~dp0.."

echo Ragam self-hosted launcher
echo =========================

docker --version >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop CLI was not found. Install or repair Docker Desktop, then try again.
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is installed but its local Engine is not ready.
  echo Open Docker Desktop, wait until it says the Engine is running, then double-click this file again.
  pause
  exit /b 1
)

docker compose version >nul 2>&1
if errorlevel 1 (
  echo Docker Compose is not available in this Docker Desktop installation.
  pause
  exit /b 1
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo Created the local .env settings file from .env.example.
  echo Enter your email on the AETHERIS_OWNER_EMAIL= line, save, and close Notepad.
  start "" notepad.exe ".env"
  echo Then double-click Start-Ragam.cmd again. No password or provider key is needed here.
  pause
  exit /b 0
)

findstr /r /c:"^AETHERIS_OWNER_EMAIL=." ".env" >nul
if errorlevel 1 (
  echo Set AETHERIS_OWNER_EMAIL to your email address in .env before starting Ragam.
  start "" notepad.exe ".env"
  pause
  exit /b 1
)

echo Checking the Compose configuration...
docker compose --env-file .env -f compose.yaml config --quiet
if errorlevel 1 (
  echo Compose configuration check failed. Review .env and try again.
  pause
  exit /b 1
)

echo Building and starting Ragam on this computer. The named volumes stay on this Docker Engine.
docker compose --env-file .env -f compose.yaml up -d --build
if errorlevel 1 (
  echo Ragam did not start. The Compose output above contains the error details.
  pause
  exit /b 1
)

echo Ragam is starting at http://localhost . Its data remains in the local Docker volume ragam-data.
start "" "http://localhost"
pause
