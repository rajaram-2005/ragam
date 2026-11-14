$paths = @(
  'scripts/Ragam-Volume.ps1',
  'scripts/Backup-Ragam.ps1',
  'scripts/Restore-Ragam.ps1'
)

foreach ($path in $paths) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $path),
    [ref]$tokens,
    [ref]$errors
  ) | Out-Null
  if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error "${path}: $($_.Message)" }
    exit 1
  }
}

Write-Output 'All Windows backup and restore scripts parse successfully.'
