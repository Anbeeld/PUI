#requires -Version 5.1
<#
.SYNOPSIS
  PUI updater for native Windows. Preserves architecture; runs smoke suite after.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== PUI update (Windows) ===" -ForegroundColor Cyan

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Resolve the actual @earendil-works/pi-coding-agent version used by installed
# pi-web: prefer the installed module tree (nested, then hoisted); fall back to
# extracting an exact semver from the dependency spec. Returns $null if unknown.
function Get-PiWebCodingAgentVersion {
  $globalRoot = & npm root -g
  $pwPkg = Join-Path (Join-Path (Join-Path $globalRoot "@agegr") "pi-web") "package.json"
  if (-not (Test-Path $pwPkg)) { return $null }
  $nested = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $globalRoot "@agegr") "pi-web") "node_modules") "@earendil-works") "pi-coding-agent\package.json"
  $hoisted = Join-Path (Join-Path (Join-Path (Join-Path $globalRoot "node_modules") "@earendil-works") "pi-coding-agent") "package.json"
  foreach ($caPkg in @($nested, $hoisted)) {
    if (Test-Path $caPkg) {
      try {
        $v = (Get-Content $caPkg -Raw | ConvertFrom-Json).version
        if ($v) { return [string]$v }
      } catch { }
    }
  }
  try {
    $dep = (Get-Content $pwPkg -Raw | ConvertFrom-Json).dependencies.'@earendil-works/pi-coding-agent'
    if ($dep -and ($dep -match '(\d+\.\d+\.\d+)')) { return $Matches[1] }
  } catch { }
  return $null
}

# 1. back up files PUI may modify
$Stack = Get-Content (Join-Path $ScriptDir "stack.json") -Raw | ConvertFrom-Json
function Expand-Path($p) { if ($p -match '^~') { return (Join-Path $env:USERPROFILE ($p -replace '^~[\\/]?','')) }; return $p }
$Lib = Join-Path $ScriptDir "lib\pui-config.js"
$piWebAccess = Expand-Path $Stack.configPaths.piWebAccess
$mcpShared = Expand-Path $Stack.configPaths.mcpShared
$piSettings = Expand-Path $Stack.configPaths.piSettings

$backupFiles = @()
foreach ($f in @($piWebAccess, $mcpShared, $piSettings) | Where-Object { Test-Path $_ }) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $bk = (& node $Lib "backup" $f 2>&1 | Select-Object -Last 1) } finally { $ErrorActionPreference = $prev }
  Write-Host "  backed up: $($bk.Trim())"
  $backupFiles += $bk.Trim()
}

# 2. update pi-web
# Stop any running pi-web process before npm install (avoids EBUSY on Windows).
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try {
  Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    try { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match '[\\/]node_modules[\\/]@agegr[\\/]pi-web[\\/]' } catch { $false }
  } | ForEach-Object { Write-Host "  stopping running pi-web (PID $($_.Id))"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
} finally { $ErrorActionPreference = $prev }

Write-Host "  updating @agegr/pi-web..."
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try {
  & npm install -g --ignore-scripts "@agegr/pi-web@latest" 2>&1 | Out-Null
  $npmExit = $LASTEXITCODE
} finally { $ErrorActionPreference = $prev }
if ($npmExit -ne 0) { Write-Host "  pi-web update failed" -ForegroundColor Red; exit 1 }

# 3. resolve pi version used by newly installed pi-web
$piWebCodingAgentVer = Get-PiWebCodingAgentVersion
if ($piWebCodingAgentVer) { Write-Host "  pi-web uses pi-coding-agent $piWebCodingAgentVer" }

# 4. install standalone pi at matching version (only when misaligned)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$piCur = $null
if (Get-Command pi -ErrorAction SilentlyContinue) { $piCur = ((& pi --version 2>$null) -replace '[^0-9.]','') }
if ($piWebCodingAgentVer -and $piCur -ne $piWebCodingAgentVer) {
  Write-Host "  aligning standalone pi to $piWebCodingAgentVer..."
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    & npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$piWebCodingAgentVer" 2>&1 | Out-Null
    $npmExit2 = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if ($npmExit2 -ne 0) { Write-Host "  pi update failed" -ForegroundColor Red; exit 1 }
} elseif (-not $piWebCodingAgentVer) {
  Write-Host "  could not resolve pi-web coding-agent version; standalone pi left unchanged"
} else {
  Write-Host "  standalone pi already at $piWebCodingAgentVer"
}

# Re-apply PUI icon override (npm update overwrites the package files).
$puiIconsDir = Join-Path $ScriptDir "assets\icons"
if (Test-Path $puiIconsDir) {
  try {
    $globalRoot = & npm root -g
    $piWebPkgRoot = Join-Path (Join-Path $globalRoot "@agegr") "pi-web"
    $piWebIconsDir = Join-Path $piWebPkgRoot "public\icons"
    if (Test-Path $piWebIconsDir) {
      Write-Host "  re-applying complete PUI icon set..."
      $iconsScript = Join-Path $ScriptDir "lib\pui-icons.js"
      $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
      try {
        & node $iconsScript apply $puiIconsDir $piWebPkgRoot 2>&1 | ForEach-Object { Write-Host "    $_" }
        $iconsExit = $LASTEXITCODE
      } finally { $ErrorActionPreference = $prev }
      if ($iconsExit -ne 0) { throw "icon helper exited $iconsExit" }
      # Apply only top-level text branding. The shared helper handles each
      # Next.js serialization shape and leaves Pi Web component references intact.
      $brandingScript = Join-Path $ScriptDir "lib\pui-branding.js"
      $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
      try {
        & node $brandingScript apply $piWebPkgRoot 2>&1 | ForEach-Object { Write-Host "    $_" }
        $brandingExit = $LASTEXITCODE
      } finally { $ErrorActionPreference = $prev }
      if ($brandingExit -ne 0) { throw "text branding helper exited $brandingExit" }
    }
  } catch {
    Write-Host "  PUI branding/icon override failed: $_" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "  PUI icon directory missing: $puiIconsDir" -ForegroundColor Red
  exit 1
}

# 5. reconcile the managed extension set, then update unpinned extensions.
# Package entries can be either unversioned or pinned (npm:<name>@<version>).
$installedPackages = @()
if (Test-Path $piSettings) {
  try {
    $settingsPackages = (Get-Content $piSettings -Raw | ConvertFrom-Json).packages
    if ($settingsPackages) { $installedPackages = @($settingsPackages) }
  } catch { Write-Host "  could not read Pi package settings: $_" -ForegroundColor Red; exit 1 }
}
function Test-ManagedPackageInstalled($spec, $packages) {
  return [bool]($packages | Where-Object {
    $_ -is [string] -and ($_ -eq $spec -or $_.StartsWith("$spec@"))
  } | Select-Object -First 1)
}
foreach ($spec in @($Stack.retiredPiPackages)) {
  if (Test-ManagedPackageInstalled $spec $installedPackages) {
    Write-Host "  retiring $spec..."
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & pi remove $spec 2>&1 | ForEach-Object { Write-Host "    $_" }; $piExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
    if ($piExit -ne 0) { Write-Host "  failed to retire $spec" -ForegroundColor Red; exit 1 }
    $installedPackages = @($installedPackages | Where-Object { $_ -ne $spec -and -not $_.StartsWith("$spec@") })
  }
}
foreach ($spec in @($Stack.piPackages)) {
  if (-not (Test-ManagedPackageInstalled $spec $installedPackages)) {
    Write-Host "  installing newly managed extension $spec..."
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & pi install $spec 2>&1 | ForEach-Object { Write-Host "    $_" }; $piExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
    if ($piExit -ne 0) { Write-Host "  failed to install $spec" -ForegroundColor Red; exit 1 }
    $installedPackages += $spec
  }
}
Write-Host "  updating Pi extensions..."
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & pi update --extensions 2>&1 | ForEach-Object { Write-Host "    $_" }; $extensionsExit = $LASTEXITCODE } catch { Write-Host "  pi update --extensions failed: $_" -ForegroundColor Red; $extensionsExit = 1 }
finally { $ErrorActionPreference = $prev }
if ($extensionsExit -ne 0) { Write-Host "  Pi extension update failed" -ForegroundColor Red; exit 1 }

# 6. refresh model catalogs
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & pi update --models 2>&1 | ForEach-Object { Write-Host "    $_" }; $modelsExit = $LASTEXITCODE } catch { Write-Host "  pi update --models failed: $_" -ForegroundColor Red; $modelsExit = 1 }
finally { $ErrorActionPreference = $prev }
if ($modelsExit -ne 0) { Write-Host "  model catalog refresh failed" -ForegroundColor Red; exit 1 }

# 7. explicit user pins are left unchanged (pi update --extensions respects them)

# 8. do not rewrite web/MCP config unless schema migration required (not in v1)

# 9. restart pi-web if autostart enabled (Startup-folder VBS launcher, not Task Scheduler)
$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherVbs = Join-Path $startupFolder "pui-piweb.vbs"
if (Test-Path $launcherVbs) {
  Write-Host "  restarting pi-web (autostart launcher present)..."
  # Stop any running pi-web node process so the new binary is picked up.
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
      try { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match '[\\/]node_modules[\\/]@agegr[\\/]pi-web[\\/]' } catch { $false }
    } | ForEach-Object { Write-Host "    stopping pi-web node (PID $($_.Id))"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    # Re-launch pi-web hidden via the same cmd shim the installer uses.
    $piWebCmd = "$env:APPDATA\npm\pi-web.cmd"
    if (Test-Path $piWebCmd) {
      # Refresh the VBS launcher so it sets PI_WEB_SKIP_VERSION_CHECK=1
      # (PUI owns update notifications; suppress pi-web's built-in check).
      $vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c set PI_WEB_SKIP_VERSION_CHECK=1&&""$piWebCmd"" --no-open", 0, False
"@
      # No BOM: Windows Script Host rejects UTF-8 BOM with "Invalid character" (800A0408).
      [System.IO.File]::WriteAllText($launcherVbs, $vbsContent, [System.Text.UTF8Encoding]::new($false))
      Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "set PI_WEB_SKIP_VERSION_CHECK=1&&`"$piWebCmd`" --no-open" -WindowStyle Hidden | Out-Null
      Start-Sleep -Seconds 5
      Write-Host "    pi-web restarted"
    }
  } finally { $ErrorActionPreference = $prev }
} else {
  Write-Host "  no autostart launcher found; skipping pi-web restart"
}

# 10. run smoke suite
Write-Host "`n=== running smoke suite ===" -ForegroundColor Cyan
$doctorScript = Join-Path $ScriptDir "doctor.ps1"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & $doctorScript; $doctorExit = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }

if ($doctorExit -ne 0) {
  Write-Host "`n=== UPDATE FAILED VALIDATION ===" -ForegroundColor Red
  Write-Host "  Installed versions:" -ForegroundColor Yellow
  if (Get-Command pi -ErrorAction SilentlyContinue) { Write-Host "    pi: $(& pi --version 2>$null)" }
  if (Get-Command pi-web -ErrorAction SilentlyContinue) { Write-Host "    pi-web: $((Get-Command pi-web).Source)" }
  if (Test-Path $piSettings) { Write-Host "  Backups preserved (restore by copying over the live file):" }
  foreach ($b in $backupFiles) { if ($b) { Write-Host "    $b" } }
  Write-Host "  Rollback hint: npm install -g @agegr/pi-web@<previous-version> and" -ForegroundColor Yellow
  Write-Host "    npm install -g @earendil-works/pi-coding-agent@<previous-version>" -ForegroundColor Yellow
  Write-Host "  Update NOT declared successful." -ForegroundColor Red
  exit 1
}

Write-Host "`nUpdate complete: all doctor checks passed." -ForegroundColor Green
