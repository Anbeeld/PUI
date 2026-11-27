param([string]$RepoRoot, [string]$FixtureRoot, [string]$Failure)
$ErrorActionPreference = "Stop"
$env:APPDATA = $FixtureRoot
$env:PI_WEB_SKIP_VERSION_CHECK = "original"
$global:fixtureRunning = $true
$global:fixtureLaunched = $false
function Get-CimInstance {
  if ($global:fixtureRunning) {
    [pscustomobject]@{ ProcessId = 4242; CommandLine = 'C:\npm\node_modules\@agegr\pi-web\bin\pi-web.js'; Name = 'node.exe' }
  }
}
function Get-NetTCPConnection { @() }
function Stop-Process {
  param($Id, [switch]$Force, $ErrorAction)
  if ($Failure -eq 'stop') { throw 'fixture stop failure' }
  if ($Id -ne 4242) { throw 'unexpected process' }
  $global:fixtureRunning = $false
  Write-Output 'STOPPED'
}
function Start-Process {
  param($FilePath, $ArgumentList, $WindowStyle, $ErrorAction)
  if ($Failure -eq 'launch') { throw 'fixture launch failure' }
  if ($global:fixtureRunning) { throw 'launched before shutdown' }
  if ($WindowStyle -ne 'Hidden') { throw 'launch must be hidden' }
  if ($ArgumentList -notlike '*pi-web.cmd*--no-open*') { throw 'wrong launch arguments' }
  if ($env:PI_WEB_SKIP_VERSION_CHECK -ne '1') { throw 'version check not disabled' }
  $global:fixtureLaunched = $true
}
function Invoke-WebRequest {
  if (-not $global:fixtureLaunched) { throw 'not launched' }
  if ($Failure -eq 'health') { throw 'fixture unhealthy' }
  [pscustomobject]@{ StatusCode = 200 }
}
function Start-Sleep {}
& (Join-Path $RepoRoot 'restart.ps1')
if (-not $global:fixtureLaunched) { throw 'never launched' }
if ($env:PI_WEB_SKIP_VERSION_CHECK -ne 'original') { throw 'environment not restored' }
Write-Output 'VERIFIED'
