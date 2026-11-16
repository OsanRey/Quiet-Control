$ErrorActionPreference='Stop'
# This launcher must refuse the physical host before elevation or file writes.
$hardware=Get-CimInstance Win32_ComputerSystem
if($hardware.Model -notmatch 'VMware') { Write-Host 'This QA launcher is only for the VMware guest. Nothing was changed.'; Read-Host 'Press Enter'; exit 64 }
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin){Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'));exit}
$qaRoot='C:\QuietControl-QA-'+(Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $qaRoot | Out-Null
Set-Content -LiteralPath ($qaRoot+'\qa-guest.marker') -Value $hardware.Model
foreach($folder in @('Build','Distribution','Fixtures','Scripts','Results')){New-Item -ItemType Directory -Path ($qaRoot+'\'+$folder) | Out-Null}
$payload=Join-Path $PSScriptRoot 'payload'
$inputs=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'QA-INPUTS.json') -Raw | ConvertFrom-Json
foreach($entry in $inputs.files){
 $inputPath=[IO.Path]::GetFullPath((Join-Path $payload $entry.path))
 if(-not $inputPath.StartsWith(([IO.Path]::GetFullPath($payload)+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid QA input path'}
 if((Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash -ne $entry.sha256){throw ('QA input hash mismatch: '+$entry.path)}
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'QA-INPUTS.json') -Destination ($qaRoot+'\Results\QA-INPUTS.json')
Copy-Item -LiteralPath (Join-Path $payload 'node.exe') -Destination ($qaRoot+'\node.exe')
Copy-Item -LiteralPath (Join-Path $payload 'satelite-proxy.exe') -Destination ($qaRoot+'\Build\satelite-proxy.exe')
Copy-Item -LiteralPath (Join-Path $payload 'Satelite-Quiet-Control-stage4-win-x64-portable.zip') -Destination ($qaRoot+'\Distribution\Satelite-Quiet-Control-stage4-win-x64-portable.zip')
Copy-Item -Path (Join-Path $payload 'Fixtures\*') -Destination ($qaRoot+'\Fixtures')
Copy-Item -Path (Join-Path $payload 'Scripts\*') -Destination ($qaRoot+'\Scripts') -Recurse
$env:QC_QA_ROOT=$qaRoot.Replace('\','/')
function Run-QACell([string]$name,[int]$seconds){
 Write-Host ('Running '+$name+' in the guest only...')
 $script=$qaRoot+'\Scripts\stage4\'+$name+'.mjs'
 $process=Start-Process -FilePath ($qaRoot+'\node.exe') -ArgumentList @($script) -WindowStyle Hidden -PassThru -RedirectStandardOutput ($qaRoot+'\Results\'+$name+'.stdout.log') -RedirectStandardError ($qaRoot+'\Results\'+$name+'.stderr.log')
 try { if(-not $process.HasExited){Wait-Process -InputObject $process -Timeout $seconds -ErrorAction Stop} } catch { $process.Refresh();if(-not $process.HasExited){taskkill.exe /F /T /PID $process.Id;Add-Content -LiteralPath ($qaRoot+'\Results\launcher-errors.log') -Value ($name+' timed out')} }
}
try {Run-QACell 'runtime' 900;Run-QACell 'ui' 600} finally {
 $resultFolder=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Quiet-Control-QA-Results';New-Item -ItemType Directory -Force -Path $resultFolder | Out-Null
 $archive=Join-Path $resultFolder 'QA-RESULTS.zip'
 if(Test-Path -LiteralPath $archive){$archive=Join-Path $resultFolder ('QA-RESULTS-'+(Get-Date -Format 'HHmmss')+'.zip')}
 Compress-Archive -Path ($qaRoot+'\Results\*') -DestinationPath $archive
 Set-Content -LiteralPath (Join-Path $resultFolder 'RESULT-LOCATION.txt') -Value $archive
 Write-Host ('Finished. Results: '+$archive)
 Start-Process -FilePath explorer.exe -ArgumentList @('/select,',('"'+$archive+'"'))
}
