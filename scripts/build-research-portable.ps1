[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$InputDirectory,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$RustBin,
  [string]$CargoHome,
  [string]$TargetDirectory,
  [string]$PnpmStore,
  [switch]$SkipInstall,
  [ValidateSet('runtime0.5','quiet-control-stage1','quiet-control-stage1.1','quiet-control-stage2','quiet-control-capture','quiet-control-stage3','quiet-control-stage3-tun-audit','quiet-control-stage4')][string]$Edition='runtime0.5'
)
$ErrorActionPreference='Stop'
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$InputDirectory=(Resolve-Path -LiteralPath $InputDirectory).Path
if($RustBin){$env:PATH=$RustBin+';'+$env:PATH}
if($CargoHome){$env:CARGO_HOME=$CargoHome}
if(!$TargetDirectory){$TargetDirectory=Join-Path $repoRoot '.research-build/target'}
$env:CARGO_TARGET_DIR=$TargetDirectory
$lock=Get-Content (Join-Path $PSScriptRoot 'portable-inputs.lock.json') -Raw|ConvertFrom-Json
foreach($entry in $lock.files){
  $path=Join-Path $InputDirectory $entry.path
  if(!(Test-Path -LiteralPath $path) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw "Input integrity failure: $($entry.path)"}
}
Copy-Item (Join-Path $InputDirectory 'resources/*') (Join-Path $repoRoot 'src-tauri/resources') -Recurse -Force
Push-Location $repoRoot
try{
  if(!$SkipInstall){
    $installArgs=@('install','--frozen-lockfile','--registry=https://registry.npmjs.org')
    if($PnpmStore){$installArgs+=@('--store-dir',$PnpmStore)}
    & pnpm @installArgs
    if($LASTEXITCODE -ne 0){throw 'pnpm install failed'}
  }
  & pnpm build
  if($LASTEXITCODE -ne 0){throw 'Frontend build failed'}
  if(Test-Path Env:TAURI_CONFIG){throw 'Clear TAURI_CONFIG: full-resource build must use committed configuration'}
  & cargo build --locked --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml
  if($LASTEXITCODE -ne 0){throw 'Native build failed'}
  & python (Join-Path $PSScriptRoot 'package-research-portable.py') --inputs $InputDirectory --exe (Join-Path $TargetDirectory 'debug/satelite-proxy.exe') --out $OutputDirectory --edition $Edition
  if($LASTEXITCODE -ne 0){throw 'Package verification failed'}
}finally{Pop-Location}
