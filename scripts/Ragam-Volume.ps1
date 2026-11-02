# Shared helpers for the Windows double-click backup and restore launchers.
# Docker volumes are mounted read-only for backup and Core is stopped by the caller.
$ErrorActionPreference = 'Stop'

function Invoke-RagamDocker {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Docker exited with status $LASTEXITCODE." }
}

function Get-RagamRunningServices {
  $lines = & docker compose -f compose.yaml ps --services --status running
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the Compose service status.' }
  return @($lines | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Assert-RagamMountPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ($Path.Contains(',')) { throw 'Docker cannot safely mount a path containing a comma. Choose another backup location.' }
}

function Save-RagamVolumeArchive {
  param([Parameter(Mandatory = $true)][string]$Path)
  $directory = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($Path))
  $name = [IO.Path]::GetFileName($Path)
  Assert-RagamMountPath $directory
  if ($name -notmatch '^[A-Za-z0-9._-]+\.tar\.gz$') { throw 'Backup filenames must use letters, numbers, dots, underscores or hyphens and end in .tar.gz.' }
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  Invoke-RagamDocker @(
    'run', '--rm',
    '--mount', 'type=volume,source=ragam-data,target=/source,readonly',
    '--mount', "type=bind,source=$directory,target=/backup",
    'busybox:1.36', 'tar', '-czf', "/backup/$name", '-C', '/source', '.'
  )
  if (!(Test-Path -LiteralPath $Path)) { throw 'Docker did not create the backup archive.' }
  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText("$Path.sha256", "$hash  $name`n", [Text.Encoding]::ASCII)
  return $hash
}

function Test-RagamArchive {
  param([Parameter(Mandatory = $true)][string]$Path)
  $directory = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($Path))
  $name = [IO.Path]::GetFileName($Path)
  Assert-RagamMountPath $directory
  if ($name -notmatch '^[A-Za-z0-9._-]+\.tar\.gz$') { throw 'The selected archive filename must use letters, numbers, dots, underscores or hyphens and end in .tar.gz.' }
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'The selected backup file does not exist.' }
  $checksumFile = "$Path.sha256"
  if (Test-Path -LiteralPath $checksumFile) {
    $line = Get-Content -LiteralPath $checksumFile -TotalCount 1
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -notmatch '^[a-f0-9]{64}$' -or $expected -ne $actual) { throw 'The backup SHA-256 checksum does not match. The volume was not changed.' }
  }
  Invoke-RagamDocker @(
    'run', '--rm',
    '--mount', "type=bind,source=$directory,target=/backup,readonly",
    'busybox:1.36', 'tar', '-tzf', "/backup/$name"
  ) *> $null
  if ($LASTEXITCODE -ne 0) { throw 'The selected file is not a readable Ragam backup archive.' }
}

function Get-RagamArchiveIdentity {
  param([Parameter(Mandatory = $true)][string]$Path)
  $directory = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($Path))
  $name = [IO.Path]::GetFileName($Path)
  Assert-RagamMountPath $directory
  $json = & docker run --rm `
    --mount "type=bind,source=$directory,target=/backup,readonly" `
    busybox:1.36 tar -xOf "/backup/$name" ./online/local-identity.json 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'The backup does not contain the local workspace identity file.' }
  try { $identity = ($json -join "`n") | ConvertFrom-Json } catch { throw 'The local workspace identity in the backup is invalid.' }
  if ($identity.version -ne 1 -or $identity.accountId -notmatch '^[0-9a-fA-F-]{36}$') {
    throw 'The backup contains an unsupported local workspace identity.'
  }
  return $identity
}

function Restore-RagamVolumeArchive {
  param([Parameter(Mandatory = $true)][string]$Path)
  $directory = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($Path))
  $name = [IO.Path]::GetFileName($Path)
  Assert-RagamMountPath $directory
  if ($name -notmatch '^[A-Za-z0-9._-]+\.tar\.gz$') { throw 'Unsafe archive filename.' }
  $script = "set -eu; find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar -xzf /backup/$name -C /target; chown -R 1000:1000 /target"
  Invoke-RagamDocker @(
    'run', '--rm',
    '--mount', 'type=volume,source=ragam-data,target=/target',
    '--mount', "type=bind,source=$directory,target=/backup,readonly",
    'busybox:1.36', 'sh', '-c', $script
  )
}

function Wait-RagamLocalWorkspace {
  param([Parameter(Mandatory = $true)][string]$ExpectedId)
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    try {
      $health = Invoke-RestMethod -Uri 'http://localhost/api/health' -TimeoutSec 3
      if ($health.status -eq 'ok') {
        $workspace = Invoke-RestMethod -Uri 'http://localhost/api/auth' -TimeoutSec 3
        if ($workspace.mode -ne 'local' -or $workspace.account.id -ne $ExpectedId) {
          throw 'The restored local workspace identity does not match the backup.'
        }
        return
      }
    } catch {
      if ($_.Exception.Message -match 'does not match the backup') { throw }
    }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'The local workspace did not become healthy after restore.'
}
