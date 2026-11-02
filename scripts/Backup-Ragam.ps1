$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
. "$PSScriptRoot\Ragam-Volume.ps1"

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $root
$stopped = $false
$failure = $null
$archive = $null
try {
  $services = Get-RagamRunningServices
  if ($services -notcontains 'core') { throw 'Start Ragam first with Start-Ragam.cmd, then run this backup launcher.' }

  $dialog = New-Object System.Windows.Forms.SaveFileDialog
  $dialog.Title = 'Choose where to save the Ragam backup'
  $dialog.Filter = 'Ragam data backup (*.tar.gz)|*.tar.gz'
  $dialog.DefaultExt = 'tar.gz'
  $dialog.AddExtension = $true
  $dialog.FileName = "ragam-data-$((Get-Date).ToString('yyyyMMdd-HHmmss')).tar.gz"
  $dialog.InitialDirectory = [Environment]::GetFolderPath('MyDocuments')
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
  $archive = $dialog.FileName

  $warning = 'This archive contains private conversation history, provider settings and the provider-encryption key. Save it only in a location protected by device encryption (such as BitLocker). Core will pause briefly during the cold backup. Continue?'
  if ([System.Windows.Forms.MessageBox]::Show($warning, 'Sensitive Ragam backup', 'YesNo', 'Warning') -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }

  Invoke-RagamDocker @('compose', '-f', 'compose.yaml', 'stop', 'core')
  $stopped = $true
  $hash = Save-RagamVolumeArchive -Path $archive
} catch {
  $failure = $_.Exception.Message
} finally {
  if ($stopped) {
    try { Invoke-RagamDocker @('compose', '-f', 'compose.yaml', 'start', 'core') }
    catch { $failure = @($failure, "Core could not be restarted: $($_.Exception.Message)") -join "`n" }
  }
}

if ($failure) {
  [System.Windows.Forms.MessageBox]::Show("Backup did not finish successfully.`n`n$failure`n`nDo not delete or replace the Docker volume.", 'Ragam backup', 'OK', 'Error') | Out-Null
  exit 1
}
if ($archive) {
  [System.Windows.Forms.MessageBox]::Show("Backup saved and SHA-256 recorded:`n$archive`n`nKeep both files together. The archive is sensitive; protect it with device or drive encryption.", 'Ragam backup complete', 'OK', 'Information') | Out-Null
}
