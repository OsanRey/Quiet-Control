$ErrorActionPreference='Stop'
# Refuse the physical host before elevation, extraction or network operations.
$hardware=Get-CimInstance Win32_ComputerSystem
if($hardware.Model -notmatch 'VMware'){Write-Host 'VMware guest only. Nothing changed.';Read-Host 'Enter';exit 64}
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
 if(-not $inputPath.StartsWith(([IO.Path]::GetFullPath($payload)+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid payload path'}
 if((Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash -ne $entry.sha256){throw ('Input hash mismatch: '+$entry.path)}
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'QA-INPUTS.json') -Destination ($qaRoot+'\Results\QA-INPUTS.json')
Copy-Item -LiteralPath (Join-Path $payload 'node.exe') -Destination ($qaRoot+'\node.exe')
Copy-Item -LiteralPath (Join-Path $payload 'Satelite-Quiet-Control-subscription-compat-win-x64-portable.zip') -Destination ($qaRoot+'\Distribution')
Copy-Item -Path (Join-Path $payload 'Scripts\*') -Destination ($qaRoot+'\Scripts') -Recurse
$env:QC_QA_ROOT=$qaRoot.Replace('\','/')
$state=[ordered]@{phase='running';startedAt=(Get-Date).ToString('o');exitCode=$null;error=$null}
try{
 Write-Host 'Subscription QA is running. Do not power off VMware: Windows will shut down normally after saving results.'
 & ($qaRoot+'\node.exe') ($qaRoot+'\Scripts\subscription-compat\acceptance.mjs') 1> ($qaRoot+'\Results\stdout.log') 2> ($qaRoot+'\Results\stderr.log')
 $state.exitCode=$LASTEXITCODE
 if($LASTEXITCODE -ne 0){throw ('Acceptance exited with code '+$LASTEXITCODE)}
 $report=Get-Content -LiteralPath ($qaRoot+'\Results\subscription.json') -Raw | ConvertFrom-Json
 if(-not $report.completedAt -or $report.phase -ne 'completed'){throw 'Incomplete report'}
 if($report.errors.Count -gt 0 -or @($report.checks | Where-Object {-not $_.passed}).Count -gt 0){throw 'Acceptance has failed checks'}
 if($report.screenshots.Count -lt 3){throw 'Screenshots incomplete'}
 $state.phase='passed'
}catch{$state.phase='failed';$state.error=$_.Exception.Message}
finally{
 $state.finishedAt=(Get-Date).ToString('o');$state | ConvertTo-Json | Set-Content -LiteralPath ($qaRoot+'\Results\launcher-state.json')
 $resultFolder=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Quiet-Control-QA-Results'
 New-Item -ItemType Directory -Force -Path $resultFolder | Out-Null
 $archive=Join-Path $resultFolder ('QA-RESULTS-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.zip')
 $partial=$archive.Replace('.zip','.partial.zip')
 Compress-Archive -Path ($qaRoot+'\Results\*') -DestinationPath $partial
 Move-Item -LiteralPath $partial -Destination $archive
 Set-Content -LiteralPath (Join-Path $resultFolder 'RESULT-LOCATION.txt') -Value $archive
 Write-Host ('QA '+$state.phase+'. Results ready: '+$archive)
 $stream=[IO.File]::Open($archive,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
 try{$stream.Flush($true)}finally{$stream.Dispose()}
 Write-Host 'Results saved. Windows will now shut down normally. Do not use VMware Power Off.'
 Start-Sleep -Seconds 3
 & shutdown.exe /s /t 0
}
