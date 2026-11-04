$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Test-PrivateIpv4([string]$Value) {
  $address = $null
  if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$address)) { return $false }
  $bytes = $address.GetAddressBytes()
  if ($bytes.Length -ne 4) { return $false }
  return ($bytes[0] -eq 10) -or
    ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
    ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
}

$bindAddress = (Read-Host 'Private LAN IPv4 address to bind (use a DHCP reservation)').Trim()
if (-not (Test-PrivateIpv4 $bindAddress)) {
  throw 'Use a private IPv4 address in 10/8, 172.16/12, or 192.168/16. Public and wildcard binds are refused.'
}

$lanHost = (Read-Host 'Hostname clients will use (same private IPv4 or a name ending in .local)').Trim().ToLowerInvariant()
if (Test-PrivateIpv4 $lanHost) {
  if ($lanHost -ne $bindAddress) { throw 'When using an IP as the Caddy hostname, it must match the private bind address.' }
} elseif ($lanHost -notmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$') {
  throw 'Use the private IPv4 address above or a valid mDNS hostname ending in .local. Schemes, ports, paths, and public names are not accepted.'
}

$authUser = (Read-Host 'Shared Basic Auth username (letters, digits, dot, underscore, or hyphen)').Trim()
if ($authUser -notmatch '^[A-Za-z0-9._-]{1,64}$') {
  throw 'Username must be 1-64 letters, digits, dots, underscores, or hyphens.'
}

$securePassword = Read-Host 'Shared password (minimum 16 characters)' -AsSecureString
$secureConfirm = Read-Host 'Repeat the shared password' -AsSecureString
$password = [System.Net.NetworkCredential]::new('', $securePassword).Password
$confirm = [System.Net.NetworkCredential]::new('', $secureConfirm).Password
if ($password.Length -lt 16) { throw 'Use a password of at least 16 characters.' }
if (-not [string]::Equals($password, $confirm, [StringComparison]::Ordinal)) { throw 'The passwords did not match.' }

# Caddy computes bcrypt inside its official container. The password is passed through
# a short-lived environment variable, never written to a file or placed in argv.
$env:RAGAM_BASIC_PASSWORD = $password
try {
  $hashOutput = & docker run --rm --env RAGAM_BASIC_PASSWORD caddy:2-alpine sh -ec 'caddy hash-password --plaintext "$RAGAM_BASIC_PASSWORD"'
  if ($LASTEXITCODE -ne 0) { throw 'Caddy could not create a password hash. Check that Docker is running and the Caddy image can be pulled.' }
} finally {
  Remove-Item Env:RAGAM_BASIC_PASSWORD -ErrorAction SilentlyContinue
  $password = $null
  $confirm = $null
}

$hash = ($hashOutput -join "`n").Trim()
if ($hash -notmatch '^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$') {
  throw 'Caddy returned an unexpected password-hash format; no deployment was started.'
}

$templatePath = Join-Path $repo 'deploy/Caddyfile.lan'
$generatedPath = Join-Path $repo 'deploy/Caddyfile.lan.local'
$template = [System.IO.File]::ReadAllText($templatePath)
$rendered = $template.Replace('__RAGAM_LAN_HOSTNAME__', $lanHost).
  Replace('__RAGAM_BASIC_AUTH_USER__', $authUser).
  Replace('__RAGAM_BASIC_AUTH_HASH__', $hash)
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($generatedPath, $rendered, $utf8NoBom)

# This file contains no password or password hash; Compose needs it only for bind/origin.
[System.IO.File]::WriteAllText((Join-Path $repo '.env.lan'),
  "RAGAM_BIND_ADDRESS=$bindAddress`nRAGAM_LAN_HOSTNAME=$lanHost`n", $utf8NoBom)

$composeArgs = @('--env-file', '.env.lan', '-f', 'compose.yaml', '-f', 'compose.lan.yaml')
& docker compose @composeArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose configuration validation failed; no containers were started.' }
& docker compose @composeArgs up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not start the LAN stack. The local loopback deployment remains available with compose.yaml alone.' }

Write-Host "LAN workspace started at https://$lanHost" -ForegroundColor Green
Write-Host 'Caddy requires its private root certificate to be trusted on each client device. Do not bypass browser certificate warnings.' -ForegroundColor Yellow

$certPath = Join-Path $repo 'deploy/ragam-lan-root.crt'
$certLines = & docker compose @composeArgs exec -T caddy cat /data/caddy/pki/authorities/local/root.crt 2>$null
if ($LASTEXITCODE -eq 0 -and $certLines) {
  [System.IO.File]::WriteAllText($certPath, (($certLines -join "`n").Trim() + "`n"), [System.Text.Encoding]::ASCII)
  Write-Host "Caddy public root certificate exported to $certPath" -ForegroundColor Green
  Write-Host 'On each Windows client, import it as a trusted Root CA (for example: certutil -addstore -f Root deploy/ragam-lan-root.crt).' -ForegroundColor Yellow
} else {
  Write-Warning "Caddy's root certificate is not available yet. After Caddy is healthy, export /data/caddy/pki/authorities/local/root.crt from its data volume and trust that certificate on each client."
}

Write-Host 'Stop without deleting data: powershell -ExecutionPolicy Bypass -File scripts/Stop-Lan-Ragam.ps1' -ForegroundColor Cyan
