# Only New-QAFixtureCertificate is pure (used by the packaging preflight).
# Trust changes require the marked VMware guest root and affect its user only.
function New-QAFixtureCertificate {
 $rsa=[Security.Cryptography.RSACng]::new(2048)
 try {
  $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Quiet Control QA HTTPS',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddIpAddress([Net.IPAddress]::Parse('203.0.113.10'));$san.AddDnsName('localhost')
  $request.CertificateExtensions.Add($san.Build())
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
  $eku=[Security.Cryptography.OidCollection]::new();[void]$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku,$true))
  return $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddHours(1))
 } finally {$rsa.Dispose()}
}
function Assert-QACertificateGuest([string]$Root) {
 if($Root -notmatch '^C:\\QuietControl-QA-\d{8}-\d{6}$' -or -not(Test-Path -LiteralPath ($Root+'\qa-guest.marker')) -or (Get-CimInstance Win32_ComputerSystem).Model -notmatch 'VMware'){throw 'Certificate trust changes are guest QA only'}
}
function Add-QAFixtureTrust([string]$Root) {
 Assert-QACertificateGuest $Root
 $certificate=New-QAFixtureCertificate
 try {
  [IO.File]::WriteAllBytes(($Root+'\fixture.pfx'),$certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,'qc43-fixture'))
  [IO.File]::WriteAllBytes(($Root+'\fixture.cer'),$certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  @{thumbprint=$certificate.Thumbprint;subject=$certificate.Subject;expires=$certificate.NotAfter.ToUniversalTime().ToString('o');scope='CurrentUser/Root in QA VM only';removed=$false} | ConvertTo-Json | Set-Content -LiteralPath ($Root+'\Results\fixture-certificate.json')
  $public=[Security.Cryptography.X509Certificates.X509Certificate2]::new(($Root+'\fixture.cer'))
  $store=[Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')
  try {$store.Open('ReadWrite');$store.Add($public)}finally{$store.Close();$public.Dispose()}
 }finally{$certificate.Dispose()}
}
function Remove-QAFixtureTrust([string]$Root) {
 Assert-QACertificateGuest $Root
 $path=$Root+'\Results\fixture-certificate.json'
 if(Test-Path -LiteralPath $path){
  $info=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  $store=[Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')
  try {
   $store.Open('ReadWrite')
   $matches=$store.Certificates.Find('FindByThumbprint',$info.thumbprint,$false)
   foreach($certificate in $matches){if($certificate.Subject -ne 'CN=Quiet Control QA HTTPS'){throw 'Unexpected QA certificate subject'};$store.Remove($certificate)}
   if($store.Certificates.Find('FindByThumbprint',$info.thumbprint,$false).Count -ne 0){throw 'QA certificate was not removed'}
   $info.removed=$true;$info | ConvertTo-Json | Set-Content -LiteralPath $path
  }finally{$store.Close()}
 }
 foreach($name in @('fixture.pfx','fixture.cer')){if(Test-Path -LiteralPath ($Root+'\'+$name)){Remove-Item -LiteralPath ($Root+'\'+$name)}}
}
