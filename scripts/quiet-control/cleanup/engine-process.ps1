# Keep the native process handle from Start(), including on Windows PowerShell 5.1.
# Drain both streams concurrently; no shell, inherited console or exit-code coercion.
function ConvertTo-QAWindowsArgument([string]$Value) {
 $escaped=[regex]::Replace($Value,'(\\*)"','$1$1\"')
 $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
 return '"'+$escaped+'"'
}
function Invoke-QAEngine([string]$Executable,[string[]]$Arguments,[string]$Stdout,[string]$Stderr,[int]$TimeoutMs=600000) {
 $info=[Diagnostics.ProcessStartInfo]::new()
 $info.FileName=$Executable
 $info.Arguments=[string]::Join(' ',@($Arguments | ForEach-Object {ConvertTo-QAWindowsArgument $_}))
 $info.WorkingDirectory=[IO.Path]::GetDirectoryName($Executable)
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 $process=[Diagnostics.Process]::new();$process.StartInfo=$info
 $output=$null;$errors=$null
 try{
  $output=[IO.File]::Open($Stdout,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $errors=[IO.File]::Open($Stderr,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  if(-not $process.Start()){throw 'QA process did not start'}
  $outTask=$process.StandardOutput.BaseStream.CopyToAsync($output)
  $errTask=$process.StandardError.BaseStream.CopyToAsync($errors)
  $timedOut=-not $process.WaitForExit($TimeoutMs)
  if($timedOut){$process.Kill()}
  $process.WaitForExit()
  $exitCode=$process.ExitCode
  if($null -eq $exitCode){throw 'Native QA exit code is unavailable'}
  if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($outTask,$errTask),10000)){throw 'QA output drain timed out'}
  return [pscustomobject]@{ExitCode=$exitCode;TimedOut=$timedOut;ProcessId=$process.Id}
 }finally{if($output){$output.Dispose()};if($errors){$errors.Dispose()};$process.Dispose()}
}
