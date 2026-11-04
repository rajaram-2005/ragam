$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
if (-not (Test-Path '.env.lan') -or -not (Test-Path 'deploy/Caddyfile.lan.local')) {
  throw 'LAN deployment settings are missing. Start it first with scripts/Start-Lan-Ragam.ps1.'
}
$composeArgs = @('--env-file', '.env.lan', '-f', 'compose.yaml', '-f', 'compose.lan.yaml')
& docker compose @composeArgs down
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not stop the LAN stack.' }
Write-Host 'LAN containers stopped. Workspace and Caddy volumes were retained.' -ForegroundColor Green
