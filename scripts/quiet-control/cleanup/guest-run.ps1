$ErrorActionPreference='Stop'
$hardware=Get-CimInstance Win32_ComputerSystem
if($hardware.Model -notmatch 'VMware'){throw 'VMware guest only; no action performed'}
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin){Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'));exit}
if(Get-Process -Name satelite-proxy -ErrorAction SilentlyContinue){throw 'Close other Satelite guest instances first'}
$qaRoot='C:\QuietControl-QA-'+(Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $qaRoot | Out-Null
Set-Content -LiteralPath ($qaRoot+'\qa-guest.marker') -Value $hardware.Model
foreach($folder in @('Distribution','Scripts','Results')){New-Item -ItemType Directory -Path ($qaRoot+'\'+$folder)|Out-Null}
$payload=Join-Path $PSScriptRoot 'payload'
$inputs=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'QA-INPUTS.json')|ConvertFrom-Json
$state=[ordered]@{phase='running';exitCode=$null;error=$null}
try{
 foreach($entry in $inputs.files){
  $sourcePath=[IO.Path]::GetFullPath((Join-Path $payload $entry.path))
  if(-not $sourcePath.StartsWith(([IO.Path]::GetFullPath($payload)+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid payload path'}
  if((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash -ne $entry.sha256){throw 'Payload hash mismatch'}
 }
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'QA-INPUTS.json') -Destination ($qaRoot+'\Results\QA-INPUTS.json')
 Copy-Item -LiteralPath (Join-Path $payload 'node.exe') -Destination ($qaRoot+'\node.exe')
 Copy-Item -LiteralPath (Join-Path $payload 'Satelite-Quiet-Control-unified-nodes-win-x64-portable.zip') -Destination ($qaRoot+'\Distribution')
 Copy-Item -Path (Join-Path $payload 'Scripts\*') -Destination ($qaRoot+'\Scripts') -Recurse
 . ($qaRoot+'\Scripts\cleanup\engine-process.ps1')
 $env:QC_QA_ROOT=$qaRoot.Replace('\','/')
 $result=Invoke-QAEngine -Executable ($qaRoot+'\node.exe') -Arguments @('--no-maglev','--no-turbofan',$qaRoot+'\Scripts\cleanup\acceptance.mjs') -Stdout ($qaRoot+'\Results\stdout.log') -Stderr ($qaRoot+'\Results\stderr.log') -TimeoutMs 360000
 $state.exitCode=$result.ExitCode
 if($result.TimedOut -or $result.ExitCode -ne 0){throw 'Cleanup QA failed; inspect retained stderr/report'}
 $report=Get-Content -Raw -LiteralPath ($qaRoot+'\Results\cleanup.json')|ConvertFrom-Json
 if(-not $report.completedAt -or $report.phase -ne 'completed' -or $report.errors.Count -gt 0 -or @($report.checks|Where-Object {-not $_.passed}).Count -gt 0){throw 'Incomplete or failed acceptance'}
 $state.phase='passed'
}catch{$state.phase='failed';$state.error=$_.Exception.ToString()}
finally{
 $state|ConvertTo-Json|Set-Content -LiteralPath ($qaRoot+'\Results\launcher-state.json')
 $resultFolder=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Quiet-Control-QA-Results'
 New-Item -ItemType Directory -Force -Path $resultFolder|Out-Null
 $archive=Join-Path $resultFolder ('QA-RESULTS-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.zip')
 Compress-Archive -Path ($qaRoot+'\Results\*') -DestinationPath $archive
 Write-Host ('QA '+$state.phase+'. Results ready: '+$archive)
 $stream=[IO.File]::Open($archive,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
 try{$stream.Flush($true)}finally{$stream.Dispose()}
 Start-Sleep -Seconds 3
 & shutdown.exe /s /t 0
}
