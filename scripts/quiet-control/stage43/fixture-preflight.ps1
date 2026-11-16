param([Parameter(Mandatory=$true)][string]$Out)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'fixture-certificate.ps1')
# Pure certificate generation: never call Add/Remove-QAFixtureTrust on the host.
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$certificate=New-QAFixtureCertificate
try {
 [IO.File]::WriteAllBytes((Join-Path $Out 'fixture.pfx'),$certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,'qc43-fixture'))
 [IO.File]::WriteAllBytes((Join-Path $Out 'fixture.cer'),$certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
}finally{$certificate.Dispose()}
