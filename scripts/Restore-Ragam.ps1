$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
. "$PSScriptRoot\Ragam-Volume.ps1"

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $root
$stopped = $false
$modified = $false
$success = $false
$failure = $null
$safetyArchive = $null
$expectedBefore = $null
$archive = $null
try {
  $services = Get-RagamRunningServices
  if ($services -notcontains 'core') { throw 'Start Ragam first with Start-Ragam.cmd. Restore requires the local stack to be running.' }

  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'Select the Ragam data backup to restore'
  $dialog.Filter = 'Ragam data backup (*.tar.gz)|*.tar.gz|All files (*.*)|*.*'
  $dialog.InitialDirectory = [Environment]::GetFolderPath('MyDocuments')
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
  $archive = $dialog.FileName
  Test-RagamArchive -Path $archive
  $expectedArchive = Get-RagamArchiveIdentity -Path $archive

  $warning = "Restore replaces the current Ragam data volume. A safety copy of the current volume will first be saved beside the selected archive. The archive contains private conversation history and provider credentials.`n`nContinue with this restore?"
  if ([System.Windows.Forms.MessageBox]::Show($warning, 'Confirm Ragam restore', 'YesNo', 'Warning') -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }

  Invoke-RagamDocker @('compose', '-f', 'compose.yaml', 'stop', 'core')
  $stopped = $true
  $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($archive))
  $safetyArchive = Join-Path $directory "ragam-before-restore-$((Get-Date).ToString('yyyyMMdd-HHmmss-fff')).tar.gz"
  Save-RagamVolumeArchive -Path $safetyArchive | Out-Null
  $expectedBefore = Get-RagamArchiveIdentity -Path $safetyArchive

  $modified = $true
  Restore-RagamVolumeArchive -Path $archive
  Invoke-RagamDocker @('compose', '-f', 'compose.yaml', 'start', 'core')
  $stopped = $false
  Wait-RagamLocalWorkspace -ExpectedId $expectedArchive.accountId
  $success = $true
} catch {
  $failure = $_.Exception.Message
  if ($modified -and $safetyArchive -and (Test-Path -LiteralPath $safetyArchive)) {
    try {
      $running = Get-RagamRunningServices
      if ($running -contains 'core') { Invoke-RagamDocker @('compose', '-f', 'compose.yaml', 'stop', 'core') }
      Restore-RagamVolumeArchive -Path $safetyArchive
      Invoke-RagamDocker @('compose', '-f', 'compose.yaml', 'start', 'core')
      $stopped = $false
      Wait-RagamLocalWorkspace -ExpectedId $expectedBefore.accountId
      $failure += "`n`nThe restore failed; the previous workspace was restored from its safety copy."
    } catch {
      $stopped = $true
      $failure += "`n`nAutomatic rollback also failed: $($_.Exception.Message). Keep the volume and both archives unchanged; do not start or delete anything until it is reviewed."
    }
  } elseif ($stopped) {
    try {
      Invoke-RagamDocker @('compose', '-f', 'compose.yaml', 'start', 'core')
      $stopped = $false
    } catch {
      $failure += "`n`nCore could not be restarted: $($_.Exception.Message). Keep the volume unchanged."
    }
  }
}

if ($success) {
  [System.Windows.Forms.MessageBox]::Show("The backup was restored and the local workspace passed its health and identity checks.`n`nA safety copy of the prior volume remains here:`n$safetyArchive`n`nKeep it until you have checked your conversations and files in Ragam.", 'Ragam restore complete', 'OK', 'Information') | Out-Null
} elseif ($failure) {
  [System.Windows.Forms.MessageBox]::Show("Restore did not complete successfully.`n`n$failure", 'Ragam restore', 'OK', 'Error') | Out-Null
  exit 1
}
