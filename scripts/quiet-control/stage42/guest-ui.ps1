$ErrorActionPreference='Stop'
# This launcher must refuse the physical host before elevation or file writes.
$hardware=Get-CimInstance Win32_ComputerSystem
if($hardware.Model -notmatch 'VMware') { Write-Host 'This QA launcher is only for the VMware guest. Nothing was changed.'; Read-Host 'Press Enter'; exit 64 }
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin){Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'));exit}
$qaRoot='C:\QuietControl-QA-'+(Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $qaRoot | Out-Null
Set-Content -LiteralPath ($qaRoot+'\qa-guest.marker') -Value $hardware.Model
foreach($folder in @('Distribution','Scripts','Results')){New-Item -ItemType Directory -Path ($qaRoot+'\'+$folder) | Out-Null}
$payload=Join-Path $PSScriptRoot 'payload'
$inputs=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'QA-INPUTS.json') -Raw | ConvertFrom-Json
foreach($entry in $inputs.files){
 $inputPath=[IO.Path]::GetFullPath((Join-Path $payload $entry.path))
 if(-not $inputPath.StartsWith(([IO.Path]::GetFullPath($payload)+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid QA input path'}
 if((Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash -ne $entry.sha256){throw ('QA input hash mismatch: '+$entry.path)}
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'QA-INPUTS.json') -Destination ($qaRoot+'\Results\QA-INPUTS.json')
Copy-Item -LiteralPath (Join-Path $payload 'node.exe') -Destination ($qaRoot+'\node.exe')
Copy-Item -LiteralPath (Join-Path $payload 'Satelite-Quiet-Control-stage4.2-win-x64-portable.zip') -Destination ($qaRoot+'\Distribution\Satelite-Quiet-Control-stage4.2-win-x64-portable.zip')
Copy-Item -Path (Join-Path $payload 'Scripts\*') -Destination ($qaRoot+'\Scripts') -Recurse
$env:QC_QA_ROOT=$qaRoot.Replace('\','/')
function Run-QACell([string]$name){
 Write-Host ('Running '+$name+' in the guest only...')
 $script=$qaRoot+'\Scripts\stage4\'+$name+'.mjs'
 $state=[ordered]@{startedAt=(Get-Date).ToString('o');phase='starting';pid=$null;exitCode=$null;error=$null}
 $stateFile=$qaRoot+'\Results\launcher-state.json'
 $state | ConvertTo-Json | Set-Content -LiteralPath $stateFile
 $state.phase='waiting';$state | ConvertTo-Json | Set-Content -LiteralPath $stateFile
 try {
  # Synchronous native invocation works consistently in Windows PowerShell 5.1.
  # The UI script owns its bounded watchdog; do not publish while Node is alive.
  & ($qaRoot+'\node.exe') $script 1> ($qaRoot+'\Results\'+$name+'.stdout.log') 2> ($qaRoot+'\Results\'+$name+'.stderr.log')
  $state.exitCode=$LASTEXITCODE
  if($LASTEXITCODE -ne 0){throw ($name+' exited with code '+$LASTEXITCODE)}
  $report=Get-Content -LiteralPath ($qaRoot+'\Results\routing-ui.json') -Raw | ConvertFrom-Json
  if(-not $report.completedAt -or $report.phase -ne 'completed'){throw 'UI report is incomplete'}
  if($report.errors.Count -gt 0 -or @($report.checks | Where-Object {-not $_.passed}).Count -gt 0){throw 'UI report contains failed checks'}
  if($report.screenshots.Count -lt 20){throw 'UI screenshots are incomplete'}
  $state.phase='passed'
 } catch {
  $state.phase='failed';$state.error=$_.Exception.Message
  Add-Content -LiteralPath ($qaRoot+'\Results\launcher-errors.log') -Value $state.error
 } finally {$state.finishedAt=(Get-Date).ToString('o');$state | ConvertTo-Json | Set-Content -LiteralPath $stateFile}
}
Copy-Item -LiteralPath (Join-Path $payload 'prior-runtime.json') -Destination ($qaRoot+'\Results\routing-runtime.json')
try {Run-QACell 'ui'} finally {
 $resultFolder=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Quiet-Control-QA-Results';New-Item -ItemType Directory -Force -Path $resultFolder | Out-Null
 $archive=Join-Path $resultFolder ('QA-RESULTS-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.zip')
 $partial=$archive.Replace('.zip','.partial.zip')
 Compress-Archive -Path ($qaRoot+'\Results\*') -DestinationPath $partial
 Move-Item -LiteralPath $partial -Destination $archive
 Set-Content -LiteralPath (Join-Path $resultFolder 'RESULT-LOCATION.txt') -Value $archive
 $outcome=(Get-Content -LiteralPath ($qaRoot+'\Results\launcher-state.json') -Raw | ConvertFrom-Json).phase
 Write-Host ('QA '+$outcome+'. Results ready: '+$archive)
 Start-Process -FilePath explorer.exe -ArgumentList @('/select,',('"'+$archive+'"'))
}
