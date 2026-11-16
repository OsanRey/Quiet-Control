param([Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path $OutputDirectory|Out-Null
. (Join-Path $PSScriptRoot 'engine-process.ps1')
$qaRoot=$OutputDirectory
$scriptSuffix='\acceptance fixture.mjs'
$scriptPath=$qaRoot+$scriptSuffix
Set-Content -LiteralPath $scriptPath -Value "console.log('QA_NODE_SCRIPT_STARTED');" -Encoding ascii
$original=@('--no-maglev','--no-turbofan',$qaRoot+$scriptSuffix)
$fixed=@('--no-maglev','--no-turbofan',($qaRoot+$scriptSuffix))
if($original.Count -eq 3){throw 'Original argument regression did not reproduce'}
if($fixed.Count -ne 3 -or $fixed[2] -ne $scriptPath){throw 'Script path was not one argument'}
$result=Invoke-QAEngine -Executable $Node -Arguments $fixed -Stdout (Join-Path $OutputDirectory 'stdout.log') -Stderr (Join-Path $OutputDirectory 'stderr.log') -TimeoutMs 10000
if($result.ExitCode -ne 0 -or (Get-Content -Raw -LiteralPath (Join-Path $OutputDirectory 'stdout.log')).Trim() -ne 'QA_NODE_SCRIPT_STARTED'){throw 'Exact launcher script failed'}
@{originalArgumentCount=$original.Count;fixedArgumentCount=$fixed.Count;exitCode=$result.ExitCode;passed=$true}|ConvertTo-Json
