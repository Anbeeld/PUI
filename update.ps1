#requires -Version 5.1
<#
.SYNOPSIS
  PUI updater for native Windows. Preserves architecture; runs smoke suite after.
#>
[CmdletBinding()]
param([switch]$ApplyStaged)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# npm's bulk-advisory audit POST stalls indefinitely on pi's large package tree;
# every npm child (including the one inside `pi install`) inherits this setting.
$env:npm_config_audit = "false"

function Wait-IfInteractive {
  if ($env:PUI_NONINTERACTIVE) { return }
  try { Write-Host ""; Read-Host -Prompt "Press Enter to close this window" | Out-Null } catch {}
}

try {

if (-not $ApplyStaged -and $env:PUI_APPLY_STAGED -ne "1") {
  & node (Join-Path $ScriptDir "lib\pui-updater.js") manual $ScriptDir
  exit $LASTEXITCODE
}
function Assert-NoInjectedFailure([string]$Boundary) {
  if ($env:PUI_FAIL_AT -eq $Boundary) { throw "Injected update failure at $Boundary" }
}

function Invoke-PiBounded {
  param([string[]]$PiArgs, [int]$TimeoutMs = 120000)
  # Network-facing `pi` commands spawn npm children that can stall indefinitely
  # on the registry or on Windows file locks. Bound each call and kill the whole
  # pi process tree on timeout so no orphaned npm survives.
  $piCommands = @(Get-Command pi -All -ErrorAction SilentlyContinue)
  if ($piCommands.Count -eq 0) { return @{ exit = 127; out = "pi not found on PATH" } }
  $piSource = $piCommands[0].Source
  foreach ($candidate in $piCommands) {
    if ($candidate.Source -match '\.(cmd|bat|exe)$') { $piSource = $candidate.Source; break }
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  if ($piSource -match '\.ps1$') {
    $psi.FileName = (Join-Path $PSHOME "powershell.exe")
    $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $piSource + '"'
  } else {
    $psi.FileName = $piSource
    $psi.Arguments = ""
  }
  foreach ($arg in $PiArgs) {
    if ($psi.Arguments) { $psi.Arguments += " " }
    if ($arg -match '[\s"]') { $psi.Arguments += '"' + ($arg -replace '"', '') + '"' } else { $psi.Arguments += $arg }
  }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $outTask = $null
  $errTask = $null
  try {
    $proc.Start() | Out-Null
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutMs)) {
      # The process may exit in the race window before taskkill runs; suppress
      # the failure so ErrorActionPreference=Stop cannot abort the lifecycle.
      $killPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try { & taskkill /PID $proc.Id /T /F *> $null } catch {}
      $ErrorActionPreference = $killPreference
      $proc.WaitForExit(15000) | Out-Null
      $code = 124
    } else { $code = $proc.ExitCode }
  } finally {
    if ($outTask) { try { $outTask.Wait(15000) | Out-Null } catch {} }
    if ($errTask) { try { $errTask.Wait(15000) | Out-Null } catch {} }
  }
  $out = ""
  if ($outTask -and $outTask.IsCompleted) { $out += $outTask.Result }
  if ($errTask -and $errTask.IsCompleted -and $errTask.Result) { if ($out) { $out += "`n" }; $out += $errTask.Result }
  if ($code -eq 124) { if ($out) { $out += "`n" }; $out += "pi $($PiArgs -join ' ') timed out after $($TimeoutMs / 1000)s" }
  return @{ exit = $code; out = $out }
}

Write-Host "=== PUI update (Windows) ===" -ForegroundColor Cyan

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# 1. back up files PUI may modify
$Stack = Get-Content (Join-Path $ScriptDir "stack.json") -Raw | ConvertFrom-Json
function Expand-Path($p) { if ($p -match '^~') { return (Join-Path $env:USERPROFILE ($p -replace '^~[\\/]?','')) }; return $p }
$Lib = Join-Path $ScriptDir "lib\pui-config.js"
$piAgentDir = Expand-Path $Stack.configPaths.piAgentDir
$piWebAccess = Expand-Path $Stack.configPaths.piWebAccess
$mcpShared = Expand-Path $Stack.configPaths.mcpShared
$piSettings = Expand-Path $Stack.configPaths.piSettings
$piFffFeatures = Expand-Path $Stack.configPaths.piFffFeatures
$piGoalSettings = Expand-Path $Stack.configPaths.piGoal
$puiSubagentsConfig = Expand-Path $Stack.configPaths.puiSubagents
$puiReasoningSummaries = Expand-Path $Stack.configPaths.puiReasoningSummaries
$puiSessionTitles = Expand-Path $Stack.configPaths.puiSessionTitles
$askUserConfig = (& node $Lib "resolve-config-path" ([string]$Stack.configPaths.askUserQuestion) ([string]$Stack.askUserQuestion.configRelativePath) 2>&1 | Select-Object -Last 1).ToString().Trim()
if ($LASTEXITCODE -ne 0) { Write-Host "  ask-user-question config path resolution failed" -ForegroundColor Red; exit 1 }

# The installed transaction worker may predate this patch. Keep a target-script
# snapshot so an introducing update can still restore these non-JSON artifacts.
$skillLoaderExtension = Join-Path $ScriptDir "lib\pui-skill-loader-extension.js"
$skillLoaderSnapshot = Join-Path ([System.IO.Path]::GetTempPath()) ("pui-skill-loader-" + [guid]::NewGuid().ToString("N"))
$skillLoaderSnapshotCommitted = $false
New-Item -ItemType Directory -Path $skillLoaderSnapshot -Force | Out-Null
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $skillLoaderExtension snapshot $skillLoaderSnapshot $ScriptDir 2>&1 | Out-Null; $skillLoaderSnapshotExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($skillLoaderSnapshotExit -ne 0) {
  Remove-Item $skillLoaderSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  $skillLoaderSnapshot = $null
  Write-Host "  could not snapshot PUI skill-loader extension; update aborted" -ForegroundColor Red
  exit 1
}
$sessionTitleExtension = Join-Path $ScriptDir "lib\pui-session-title-extension.js"
$sessionTitleSnapshot = Join-Path ([System.IO.Path]::GetTempPath()) ("pui-session-title-" + [guid]::NewGuid().ToString("N"))
$sessionTitleSnapshotCommitted = $false
New-Item -ItemType Directory -Path $sessionTitleSnapshot -Force | Out-Null
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $sessionTitleExtension snapshot $sessionTitleSnapshot $ScriptDir 2>&1 | Out-Null; $sessionTitleSnapshotExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($sessionTitleSnapshotExit -ne 0) {
  Remove-Item $skillLoaderSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $sessionTitleSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  $skillLoaderSnapshot = $null
  $sessionTitleSnapshot = $null
  Write-Host "  could not snapshot PUI session-title extension; update aborted" -ForegroundColor Red
  exit 1
}
$backgroundPatch = Join-Path $ScriptDir "lib\pui-background-tasks-patch.js"
$backgroundSnapshot = Join-Path ([System.IO.Path]::GetTempPath()) ("pui-background-task-" + [guid]::NewGuid().ToString("N"))
$backgroundPatchCommitted = $false
New-Item -ItemType Directory -Path $backgroundSnapshot -Force | Out-Null
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $backgroundPatch snapshot $backgroundSnapshot 2>&1 | Out-Null; $backgroundSnapshotExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($backgroundSnapshotExit -ne 0) {
  Remove-Item $backgroundSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $skillLoaderSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $sessionTitleSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  $backgroundSnapshot = $null
  $skillLoaderSnapshot = $null
  $sessionTitleSnapshot = $null
  Write-Host "  could not snapshot pi-background-tasks compatibility artifacts; update aborted" -ForegroundColor Red
  exit 1
}
$subagentsPatch = Join-Path $ScriptDir "lib\pui-subagents-patch.js"
$subagentsSnapshot = Join-Path ([System.IO.Path]::GetTempPath()) ("pui-subagents-" + [guid]::NewGuid().ToString("N"))
$subagentsPatchCommitted = $false
New-Item -ItemType Directory -Path $subagentsSnapshot -Force | Out-Null
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $subagentsPatch snapshot $subagentsSnapshot 2>&1 | Out-Null; $subagentsSnapshotExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($subagentsSnapshotExit -ne 0) {
  Remove-Item $backgroundSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $subagentsSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $skillLoaderSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $sessionTitleSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  $backgroundSnapshot = $null
  $subagentsSnapshot = $null
  $sessionTitleSnapshot = $null
  Write-Host "  could not snapshot pi-subagents prompt artifacts; update aborted" -ForegroundColor Red
  exit 1
}
$globalRoot = & npm root -g
$reasoningPatch = Join-Path $ScriptDir "lib\pui-reasoning-summary-patch.js"
$reasoningSnapshot = Join-Path ([System.IO.Path]::GetTempPath()) ("pui-reasoning-summary-" + [guid]::NewGuid().ToString("N"))
$reasoningPatchCommitted = $false
$reasoningPiWebRoot = Join-Path (Join-Path $globalRoot "@agegr") "pi-web"
$reasoningStandaloneRoot = Join-Path $globalRoot "@earendil-works\pi-coding-agent"
New-Item -ItemType Directory -Path $reasoningSnapshot -Force | Out-Null
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $reasoningPatch snapshot $reasoningSnapshot $ScriptDir $reasoningPiWebRoot $reasoningStandaloneRoot 2>&1 | Out-Null; $reasoningSnapshotExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($reasoningSnapshotExit -ne 0) {
  Remove-Item $backgroundSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $subagentsSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $reasoningSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $skillLoaderSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $sessionTitleSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  $backgroundSnapshot = $null
  $subagentsSnapshot = $null
  $reasoningSnapshot = $null
  $skillLoaderSnapshot = $null
  $sessionTitleSnapshot = $null
  Write-Host "  could not snapshot Responses reasoning-summary artifacts; update aborted" -ForegroundColor Red
  exit 1
}

$backupFiles = @()
foreach ($f in @($piWebAccess, $mcpShared, $piSettings, $piFffFeatures, $piGoalSettings, $askUserConfig, $puiSubagentsConfig, $puiReasoningSummaries, $puiSessionTitles) | Where-Object { Test-Path $_ }) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    $bkOutput = & node $Lib "backup" $f 2>&1
    $bkExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if ($bkExit -ne 0) { Write-Host "  backup failed: $f — $($bkOutput -join ' ')" -ForegroundColor Red; exit 1 }
  $bk = ($bkOutput | Select-Object -Last 1).ToString().Trim()
  Write-Host "  backed up: $bk"
  $backupFiles += $bk
}
if (Test-Path $puiReasoningSummaries) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & node $Lib "validate-reasoning-summary-modes" $puiReasoningSummaries 2>&1 | Out-Null; $reasoningSummaryPreflightExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
  if ($reasoningSummaryPreflightExit -ne 0) {
    Write-Host "  invalid reasoning-summary configuration backed up and left unchanged: $puiReasoningSummaries" -ForegroundColor Red
    exit 1
  }
}
if (Test-Path $puiSessionTitles) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & node $Lib "validate-session-titles" $puiSessionTitles 2>&1 | Out-Null; $sessionTitlePreflightExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
  if ($sessionTitlePreflightExit -ne 0) {
    Write-Host "  invalid session-title configuration backed up and left unchanged: $puiSessionTitles" -ForegroundColor Red
    exit 1
  }
}

# 2. update pi-web
# Stop any running pi-web process before npm install (avoids EBUSY on Windows).
# Detection combines a command-line match with a port-listener fallback so a
# transient WMI enumeration miss cannot leave a running pi-web unreported.
function Get-PiWebPid {
  $pids = @{}
  foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match '[\\/]node_modules[\\/]@agegr[\\/]pi-web[\\/]'
  })) { $pids[[int]$p.ProcessId] = $true }
  try {
    foreach ($conn in @(Get-NetTCPConnection -LocalPort $Stack.piWeb.port -State Listen -ErrorAction Stop)) {
      $ownerPid = [int]$conn.OwningProcess
      if ($ownerPid -gt 0 -and -not $pids.ContainsKey($ownerPid)) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
        if ($owner -and $owner.Name -match '^node(\.exe)?$') { $pids[$ownerPid] = $true }
      }
    }
  } catch {}
  return @($pids.Keys)
}
function Wait-PiWebStopped {
  param([int]$Attempts = 15)
  for ($wait = 0; $wait -lt $Attempts; $wait += 1) {
    if (@(Get-PiWebPid).Count -eq 0) { return $true }
    Start-Sleep -Seconds 1
  }
  return (@(Get-PiWebPid).Count -eq 0)
}
function Wait-PiWebHealthy {
  param([int]$Attempts = 30, [int]$Consecutive = 2)
  $healthyCount = 0
  for ($attempt = 0; $attempt -lt $Attempts; $attempt += 1) {
    try {
      $response = Invoke-WebRequest $Stack.piWeb.url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
      if ([int]$response.StatusCode -eq 200) {
        $healthyCount += 1
        if ($healthyCount -ge $Consecutive) { return $true }
      } else { $healthyCount = 0 }
    } catch { $healthyCount = 0 }
    Start-Sleep -Seconds 2
  }
  return $false
}

if (@(Get-PiWebPid).Count -gt 0) {
  try { $runningState = Invoke-RestMethod "$($Stack.piWeb.url)/api/agent/running" -TimeoutSec 3 -ErrorAction Stop }
  catch { Write-Host "  could not verify Pi Web idle state; update aborted" -ForegroundColor Red; exit 1 }
  if (-not $runningState.PSObject.Properties['runningSessionIds']) { Write-Host "  Pi Web returned an invalid activity response; update aborted" -ForegroundColor Red; exit 1 }
  if (@($runningState.runningSessionIds).Count -gt 0) {
    Write-Host "  active Pi Web sessions appeared; update deferred without stopping them" -ForegroundColor Yellow
    exit 75
  }
}
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try {
  foreach ($pidToStop in @(Get-PiWebPid)) { Write-Host "  stopping running pi-web (PID $pidToStop)"; Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue }
  if (-not (Wait-PiWebStopped)) {
    Write-Host "  could not stop Pi Web before package mutation; update aborted" -ForegroundColor Red
    exit 1
  }
} finally { $ErrorActionPreference = $prev }

& node (Join-Path $ScriptDir "lib\pui-updater.js") standalone-busy
if ($LASTEXITCODE -eq 75) { Write-Host "  standalone Pi became active; update deferred" -ForegroundColor Yellow; exit 75 }
if ($LASTEXITCODE -ne 0) { Write-Host "  could not verify standalone Pi idle state" -ForegroundColor Red; exit 1 }

Write-Host "  updating @agegr/pi-web..."
$piWebSpec = "$($Stack.upstream.gui.npm)@$($Stack.upstream.gui.version)"
$npmExit = 1
$npmErr = ""
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try {
  # npm may report EBUSY briefly after Pi Web stops while Windows releases the directory lock; retry.
  for ($attempt = 1; $attempt -le 5 -and $npmExit -ne 0; $attempt += 1) {
    if ($attempt -gt 1) { Write-Host "  retrying pi-web install (attempt $attempt)..." -ForegroundColor Yellow; Start-Sleep -Seconds 2 }
    $npmErr = (& npm install -g --ignore-scripts $piWebSpec 2>&1 | Out-String)
    $npmExit = $LASTEXITCODE
  }
} finally { $ErrorActionPreference = $prev }
if ($npmExit -ne 0) {
  Write-Host "  pi-web update failed" -ForegroundColor Red
  Write-Host $npmErr -ForegroundColor DarkGray
  exit 1
}

# 3. resolve pi version used by newly installed pi-web
$piWebCodingAgentVer = [string]$Stack.upstream.agentRuntime.version
if ($piWebCodingAgentVer) { Write-Host "  pi-web uses pi-coding-agent $piWebCodingAgentVer" }

# 4. install standalone pi at matching version (only when misaligned)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$piCur = $null
if (Get-Command pi -ErrorAction SilentlyContinue) { $piCur = ((& pi --version 2>$null) -replace '[^0-9.]','') }
if ($piWebCodingAgentVer -and $piCur -ne $piWebCodingAgentVer) {
  Write-Host "  aligning standalone pi to $piWebCodingAgentVer..."
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    & npm install -g --ignore-scripts "$($Stack.upstream.agentRuntime.npm)@$piWebCodingAgentVer" 2>&1 | Out-Null
    $npmExit2 = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if ($npmExit2 -ne 0) { Write-Host "  pi update failed" -ForegroundColor Red; exit 1 }
} elseif (-not $piWebCodingAgentVer) {
  Write-Host "  could not resolve pi-web coding-agent version; standalone pi left unchanged"
} else {
  Write-Host "  standalone pi already at $piWebCodingAgentVer"
}

# Apply the temporary exact-version Pi #8782 runtime backport before any
# restart. This is fatal: an unpatched PUI Pi Web is unsupported.
$globalRoot = & npm root -g
$piWebPkgRoot = Join-Path (Join-Path $globalRoot "@agegr") "pi-web"
$backportScript = Join-Path $ScriptDir "lib\pui-pi-8782-backport.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $backportScript apply $ScriptDir $piWebPkgRoot 2>&1 | Out-Null; $backportExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($backportExit -ne 0) { Write-Host "  Pi #8782 backport could not be applied; update aborted" -ForegroundColor Red; exit 1 }
Assert-NoInjectedFailure "pi-8782-backport"
Write-Host "  Pi #8782 backport applied to Pi Web runtime"

$standalonePiRoot = Join-Path $globalRoot "@earendil-works\pi-coding-agent"
$reasoningPatchScript = Join-Path $ScriptDir "lib\pui-reasoning-summary-patch.js"
$integrationScript = Join-Path $ScriptDir "lib\pui-web-integration.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $reasoningPatchScript migrate-legacy $ScriptDir $piWebPkgRoot $standalonePiRoot 2>&1 | Out-Null; $reasoningMigrationExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($reasoningMigrationExit -ne 0) { Write-Host "  previous reasoning-summary ownership could not be migrated; update aborted" -ForegroundColor Red; exit 1 }

# Re-apply PUI icon override (npm update overwrites the package files).
$puiIconsDir = Join-Path $ScriptDir "assets\icons"
if (Test-Path $puiIconsDir) {
  try {
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
      & node $integrationScript apply $ScriptDir $piWebPkgRoot 2>&1 | ForEach-Object { Write-Host "    $_" }
      if ($LASTEXITCODE -ne 0) { throw "Pi Web update integration failed" }
      Assert-NoInjectedFailure "pi-web-integration"
    }
  } catch {
    Write-Host "  PUI branding/icon override failed: $_" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "  PUI icon directory missing: $puiIconsDir" -ForegroundColor Red
  exit 1
}

# Apply after branding because both transforms own Pi Web page bundles.
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $reasoningPatchScript apply $ScriptDir $piWebPkgRoot $standalonePiRoot 2>&1 | Out-Null; $reasoningPatchExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($reasoningPatchExit -ne 0) { Write-Host "  reasoning-summary compatibility patch could not be applied; update aborted" -ForegroundColor Red; exit 1 }
Assert-NoInjectedFailure "reasoning-summary-patch"
Write-Host "  Responses reasoning-summary display patch applied to Pi Web and standalone Pi"
& node $integrationScript finalize $ScriptDir $piWebPkgRoot 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "  Pi Web update integration finalization failed; update aborted" -ForegroundColor Red; exit 1 }

# 5. reconcile the exact PUI-managed extension set.
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
    $piRemove = Invoke-PiBounded -PiArgs @("remove", $spec)
    if ($piRemove.out) { $piRemove.out -split "`r?`n" | ForEach-Object { if ($_) { Write-Host "    $_" } } }
    $piExit = $piRemove.exit
    if ($piExit -ne 0) { Write-Host "  failed to retire $spec" -ForegroundColor Red; exit 1 }
    $installedPackages = @($installedPackages | Where-Object { $_ -ne $spec -and -not $_.StartsWith("$spec@") })
  }
}
foreach ($spec in @($Stack.piPackages)) {
  Write-Host "  reconciling managed extension $spec..."
  $piInstall = Invoke-PiBounded -PiArgs @("install", $spec)
  if ($piInstall.out) { $piInstall.out -split "`r?`n" | ForEach-Object { if ($_) { Write-Host "    $_" } } }
  $piExit = $piInstall.exit
  if ($piExit -ne 0) { Write-Host "  failed to install $spec" -ForegroundColor Red; exit 1 }
  & node (Join-Path $ScriptDir "lib\pui-config.js") set-package $piSettings $spec | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host "  failed to set exact managed pin for $spec" -ForegroundColor Red; exit 1 }
}
Assert-NoInjectedFailure "package-reconciliation"

$askGuidance = $Stack.askUserQuestion.guidance | ConvertTo-Json -Depth 10 -Compress
$askGuidanceFile = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($askGuidanceFile, $askGuidance, [System.Text.UTF8Encoding]::new($false))
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & node $Lib "set-owned-fields" $askUserConfig "guidance" "@$askGuidanceFile" 2>&1 | Out-Null; $askGuidanceExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
} finally { Remove-Item $askGuidanceFile -Force -ErrorAction SilentlyContinue }
if ($askGuidanceExit -ne 0) { Write-Host "  ask-user-question guidance reconciliation failed" -ForegroundColor Red; exit 1 }
Write-Host "  ask-user-question guidance reconciled"

$reasoningSummaryDefaults = $Stack.reasoningSummaries.modelModes | ConvertTo-Json -Depth 10 -Compress
$reasoningSummaryDefaultsFile = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($reasoningSummaryDefaultsFile, $reasoningSummaryDefaults, [System.Text.UTF8Encoding]::new($false))
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & node $Lib "ensure-reasoning-summary-modes" $puiReasoningSummaries "@$reasoningSummaryDefaultsFile" 2>&1 | Out-Null; $reasoningSummaryConfigExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
} finally { Remove-Item $reasoningSummaryDefaultsFile -Force -ErrorAction SilentlyContinue }
if ($reasoningSummaryConfigExit -ne 0) { Write-Host "  reasoning-summary configuration is invalid and was not overwritten" -ForegroundColor Red; exit 1 }
Write-Host "  reasoning-summary modes ready: $puiReasoningSummaries"

$sessionTitleDefaults = ConvertTo-Json -InputObject @($Stack.sessionTitles.models) -Compress
$sessionTitleDefaultsFile = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($sessionTitleDefaultsFile, $sessionTitleDefaults, [System.Text.UTF8Encoding]::new($false))
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & node $Lib "ensure-session-titles" $puiSessionTitles "@$sessionTitleDefaultsFile" 2>&1 | Out-Null; $sessionTitleConfigExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
} finally { Remove-Item $sessionTitleDefaultsFile -Force -ErrorAction SilentlyContinue }
if ($sessionTitleConfigExit -ne 0) { Write-Host "  session-title configuration is invalid and was not overwritten" -ForegroundColor Red; exit 1 }
Write-Host "  session-title models ready: $puiSessionTitles"

$subagentDefaults = $Stack.subagents.modelMappings | ConvertTo-Json -Depth 10 -Compress
$subagentDefaultsFile = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($subagentDefaultsFile, $subagentDefaults, [System.Text.UTF8Encoding]::new($false))
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & node $Lib "reconcile-model-mappings" $puiSubagentsConfig "@$subagentDefaultsFile" 2>&1 | Out-Null; $subagentConfigExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
} finally { Remove-Item $subagentDefaultsFile -Force -ErrorAction SilentlyContinue }
if ($subagentConfigExit -ne 0) { Write-Host "  subagent model mapping reconciliation failed" -ForegroundColor Red; exit 1 }
Write-Host "  subagent fuzzy model mappings reconciled: $puiSubagentsConfig"

# Reconcile pi-fff feature state: suppress startup notices while keeping
# PUI's fuzzy features active, and remove retired custom agent tools.
$fffCfg = @{ enabledFeatures = @($Stack.fff.enabledFeatures) } | ConvertTo-Json -Depth 10 -Compress
$fffCfgFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($fffCfgFile, $fffCfg, [System.Text.UTF8Encoding]::new($false))
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $Lib "merge-object" $piFffFeatures "@$fffCfgFile" 2>&1 | Out-Null; $fffExit = $LASTEXITCODE }
finally { Remove-Item $fffCfgFile -Force -ErrorAction SilentlyContinue; $ErrorActionPreference = $prev }
if ($fffExit -ne 0) { Write-Host "  pi-fff feature state reconciliation failed" -ForegroundColor Red; exit 1 }
$fffRetired = ConvertTo-Json -InputObject @($Stack.fff.retiredFeatures) -Depth 10 -Compress
$fffRetiredFile = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($fffRetiredFile, $fffRetired, [System.Text.UTF8Encoding]::new($false))
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & node $Lib "remove-array-items" $piFffFeatures "enabledFeatures" "@$fffRetiredFile" 2>&1 | Out-Null; $fffRetiredExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
} finally { Remove-Item $fffRetiredFile -Force -ErrorAction SilentlyContinue }
if ($fffRetiredExit -ne 0) { Write-Host "  pi-fff retired feature removal failed" -ForegroundColor Red; exit 1 }
Write-Host "  pi-fff feature state reconciled (startup notices disabled; custom agent tools disabled)"

# Reconcile pi-goal settings: unlimited automatic turns with a readable status line.
$goalCfg = '{"continuationLimits":{"automaticTurns":null,"noProgressTurns":3}}'
$goalCfgFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($goalCfgFile, $goalCfg, [System.Text.UTF8Encoding]::new($false))
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $Lib "merge-object" $piGoalSettings "@$goalCfgFile" 2>&1 | Out-Null; $goalExit = $LASTEXITCODE }
finally { Remove-Item $goalCfgFile -Force -ErrorAction SilentlyContinue; $ErrorActionPreference = $prev }
if ($goalExit -ne 0) { Write-Host "  pi-goal settings reconciliation failed" -ForegroundColor Red; exit 1 }
$goalPatchScript = Join-Path $ScriptDir "lib\pui-goal-patch.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $goalPatchScript apply 2>&1 | Out-Null; $goalPatchExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($goalPatchExit -ne 0) { Write-Host "  pi-goal status patch could not be applied (version drift); the turn counter may still show 'automatic Unlimited'." -ForegroundColor Yellow }
else { Write-Host "  pi-goal configured for unlimited turns with a readable status line" }

# Verify the node-pty native binding for @99percentpeople/pi-background-tasks.
$nativeCheck = Join-Path $ScriptDir "lib\pui-native-check.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $nativeCheck ensure (Join-Path $piAgentDir "npm") 2>&1 | Out-Null; $nativeExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($nativeExit -ne 0) { Write-Host "  pi-background-tasks native (node-pty) binding could not be verified or rebuilt; update aborted. Install the required compiler toolchain and rerun update.ps1." -ForegroundColor Red; exit 1 }
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $backgroundPatch apply 2>&1 | Out-Null; $backgroundPatchExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($backgroundPatchExit -ne 0) { Write-Host "  pi-background-tasks compatibility patch could not be applied (version or bundle drift); update aborted." -ForegroundColor Red; exit 1 }
Write-Host "  pi-background-tasks compact guidance and runtime isolation applied"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $subagentsPatch apply 2>&1 | Out-Null; $subagentsPatchExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($subagentsPatchExit -ne 0) { Write-Host "  pi-subagents policy patch could not be applied (version or metadata drift); update aborted." -ForegroundColor Red; exit 1 }
Write-Host "  pi-subagents policy applied"

Write-Host "  reconciling managed Playwright MCP..."
$mcpDef = [ordered]@{
  command = [string]$Stack.mcp.command
  args = @($Stack.mcp.args)
  lifecycle = [string]$Stack.mcp.lifecycle
  directTools = @($Stack.mcp.directTools)
} | ConvertTo-Json -Depth 10 -Compress
$mcpDefFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($mcpDefFile, $mcpDef, [System.Text.UTF8Encoding]::new($false))
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try {
  & node $Lib "set-server" $mcpShared ([string]$Stack.mcp.serverName) "@$mcpDefFile" 2>&1 | Out-Null
  $mcpExit = $LASTEXITCODE
} finally {
  Remove-Item $mcpDefFile -Force -ErrorAction SilentlyContinue
  $ErrorActionPreference = $prev
}
if ($mcpExit -eq 2) {
  Write-Host "  existing Playwright MCP has a materially different configuration; update aborted" -ForegroundColor Red
  exit 1
}
if ($mcpExit -ne 0) {
  Write-Host "  failed to reconcile Playwright MCP" -ForegroundColor Red
  exit 1
}
# Reconcile MCP footer status: keep the extension status bar quiet.
$mcFooterCfg = @{ settings = @{ mcpFooterStatus = [string]$Stack.mcp.footerStatus } } | ConvertTo-Json -Compress
$mcFooterFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($mcFooterFile, $mcFooterCfg, [System.Text.UTF8Encoding]::new($false))
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $Lib "merge-object" $mcpShared "@$mcFooterFile" 2>&1 | Out-Null; $mcFooterExit = $LASTEXITCODE }
finally { Remove-Item $mcFooterFile -Force -ErrorAction SilentlyContinue; $ErrorActionPreference = $prev }
if ($mcFooterExit -ne 0) { Write-Host "  MCP footer status reconciliation failed" -ForegroundColor Red; exit 1 }
Write-Host "  MCP footer status configured (mcpFooterStatus=$($Stack.mcp.footerStatus))"
Assert-NoInjectedFailure "config-migration"
& node (Join-Path $ScriptDir "lib\pui-update-extension.js") install $ScriptDir | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "  PUI update extension replacement failed" -ForegroundColor Red; exit 1 }
& node (Join-Path $ScriptDir "lib\pui-skill-loader-extension.js") install $ScriptDir | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "  PUI skill loader extension replacement failed" -ForegroundColor Red; exit 1 }
& node (Join-Path $ScriptDir "lib\pui-reasoning-summary-extension.js") install $ScriptDir | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "  PUI reasoning-summary extension replacement failed" -ForegroundColor Red; exit 1 }
& node (Join-Path $ScriptDir "lib\pui-session-title-extension.js") install $ScriptDir | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "  PUI session-title extension replacement failed" -ForegroundColor Red; exit 1 }
Assert-NoInjectedFailure "extension-replacement"

# 6. refresh model catalogs
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { $modelsResult = Invoke-PiBounded -PiArgs @("update", "--models"); $modelsExit = $modelsResult.exit; if ($modelsResult.out) { $modelsResult.out -split "`r?`n" | ForEach-Object { if ($_) { Write-Host "    $_" } } } } catch { Write-Host "  pi update --models failed: $_" -ForegroundColor Red; $modelsExit = 1 }
finally { $ErrorActionPreference = $prev }
if ($modelsExit -ne 0) { Write-Host "  model catalog refresh failed" -ForegroundColor Red; exit 1 }

# 7. managed pins converge to stack.json; unrelated package pins are preserved.

# 8. do not rewrite web/MCP config unless schema migration required (not in v1)

# 9. restart pi-web if autostart enabled. Keep the VBS as the logon
# registration, but launch the absolute npm shim directly so update and
# rollback receive the same observable health gate as initial installation.
$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherVbs = Join-Path $startupFolder "pui-piweb.vbs"
if (Test-Path $launcherVbs) {
  Write-Host "  restarting pi-web (autostart registration present)..."
  # Stop any running pi-web node process so the new binary is picked up.
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    foreach ($pidToStop in @(Get-PiWebPid)) { Write-Host "    stopping pi-web node (PID $pidToStop)"; Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue }
    if (-not (Wait-PiWebStopped)) {
      Write-Host "  could not stop Pi Web before restart; update aborted" -ForegroundColor Red
      exit 1
    }
    $piWebCmd = "$env:APPDATA\npm\pi-web.cmd"
    if (-not (Test-Path $piWebCmd)) { Write-Host "  Pi Web launcher is missing: $piWebCmd" -ForegroundColor Red; exit 1 }
    # Refresh the VBS registration so login startup remains hidden and PUI owns
    # update discovery instead of Pi Web's npm version checker.
    $vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c set PI_WEB_SKIP_VERSION_CHECK=1&&""$piWebCmd"" --no-open", 0, False
"@
    # No BOM: Windows Script Host rejects UTF-8 BOM with "Invalid character" (800A0408).
    [System.IO.File]::WriteAllText($launcherVbs, $vbsContent, [System.Text.UTF8Encoding]::new($false))
    $previousSkipVersionCheck = $env:PI_WEB_SKIP_VERSION_CHECK
    try {
      $env:PI_WEB_SKIP_VERSION_CHECK = "1"
      $launchArgs = '/d /s /c ""{0}" --no-open"' -f $piWebCmd
      Start-Process -FilePath $env:ComSpec -ArgumentList $launchArgs -WindowStyle Hidden | Out-Null
    } finally {
      if ($null -eq $previousSkipVersionCheck) { Remove-Item Env:PI_WEB_SKIP_VERSION_CHECK -ErrorAction SilentlyContinue }
      else { $env:PI_WEB_SKIP_VERSION_CHECK = $previousSkipVersionCheck }
    }
    Write-Host "    pi-web hidden launch requested"
    # Require two consecutive HTTP 200 responses so a stale or short-lived
    # process cannot pass this gate before the doctor smoke suite runs.
    if (-not (Wait-PiWebHealthy)) { Write-Host "  pi-web did not reach stable running state with HTTP 200 within 60s" -ForegroundColor Red; exit 1 }
    Write-Host "    pi-web restarted hidden and is running and healthy at $($Stack.piWeb.url)"
  } finally { $ErrorActionPreference = $prev }
} else {
  Write-Host "  no autostart registration found; skipping pi-web restart"
}

# 10. run smoke suite
Write-Host "`n=== running smoke suite ===" -ForegroundColor Cyan
$doctorScript = Join-Path $ScriptDir "doctor.ps1"
Assert-NoInjectedFailure "restart-health"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
$prevNonInteractive = $env:PUI_NONINTERACTIVE
$env:PUI_NONINTERACTIVE = "1"
try { & $doctorScript; $doctorExit = $LASTEXITCODE } finally {
  $ErrorActionPreference = $prev
  $env:PUI_NONINTERACTIVE = $prevNonInteractive
}

if ($doctorExit -ne 0) {
  Write-Host "`n=== UPDATE FAILED VALIDATION ===" -ForegroundColor Red
  Write-Host "  Installed versions:" -ForegroundColor Yellow
  if (Get-Command pi -ErrorAction SilentlyContinue) { Write-Host "    pi: $(& pi --version 2>$null)" }
  if (Get-Command pi-web -ErrorAction SilentlyContinue) { Write-Host "    pi-web: $((Get-Command pi-web).Source)" }
  if (Test-Path $piSettings) { Write-Host "  Backups preserved (restore by copying over the live file):" }
  foreach ($b in $backupFiles) { if ($b) { Write-Host "    $b" } }
  Write-Host "  The transaction worker will restore and validate the previous certified PUI release." -ForegroundColor Yellow
  Write-Host "  Update NOT declared successful." -ForegroundColor Red
  exit 1
}
Assert-NoInjectedFailure "target-validation"
$puiVersion = (Get-Content (Join-Path $ScriptDir "package.json") -Raw | ConvertFrom-Json).version
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $backgroundPatch spawn-guard $backgroundSnapshot $puiVersion 2>&1 | Out-Null; $backgroundGuardExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($backgroundGuardExit -eq 75 -or $backgroundGuardExit -eq 76) {
  # A direct staged apply has no outer validation; a checkpoint route already
  # has one transaction-level guard retaining the original snapshot.
  $backgroundPatchCommitted = $true
  Remove-Item $backgroundSnapshot -Recurse -Force
  $backgroundSnapshot = $null
} elseif ($backgroundGuardExit -ne 0) {
  throw "Could not start the outer-transaction background prompt rollback guard"
} else {
  $backgroundGuardReady = Join-Path $backgroundSnapshot "guard-ready"
  for ($guardWait = 0; $guardWait -lt 50 -and -not (Test-Path $backgroundGuardReady); $guardWait += 1) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path $backgroundGuardReady)) { throw "Background prompt rollback guard did not become ready" }
  $backgroundPatchCommitted = $true
}
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $subagentsPatch spawn-guard $subagentsSnapshot $puiVersion 2>&1 | Out-Null; $subagentsGuardExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($subagentsGuardExit -eq 75 -or $subagentsGuardExit -eq 76) {
  # A direct staged apply has no outer validation; a checkpoint route already
  # has one transaction-level guard retaining the original snapshot.
  $subagentsPatchCommitted = $true
  Remove-Item $subagentsSnapshot -Recurse -Force
  $subagentsSnapshot = $null
} elseif ($subagentsGuardExit -ne 0) {
  throw "Could not start the outer-transaction subagents prompt rollback guard"
} else {
  $subagentsGuardReady = Join-Path $subagentsSnapshot "guard-ready"
  for ($guardWait = 0; $guardWait -lt 50 -and -not (Test-Path $subagentsGuardReady); $guardWait += 1) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path $subagentsGuardReady)) { throw "Subagents prompt rollback guard did not become ready" }
  $subagentsPatchCommitted = $true
}
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $skillLoaderExtension spawn-guard $skillLoaderSnapshot $puiVersion $ScriptDir 2>&1 | Out-Null; $skillLoaderGuardExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($skillLoaderGuardExit -eq 75 -or $skillLoaderGuardExit -eq 76) {
  $skillLoaderSnapshotCommitted = $true
  Remove-Item $skillLoaderSnapshot -Recurse -Force
  $skillLoaderSnapshot = $null
} elseif ($skillLoaderGuardExit -ne 0) {
  throw "Could not start the outer-transaction skill-loader rollback guard"
} else {
  $skillLoaderGuardReady = Join-Path $skillLoaderSnapshot "guard-ready"
  for ($guardWait = 0; $guardWait -lt 50 -and -not (Test-Path $skillLoaderGuardReady); $guardWait += 1) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path $skillLoaderGuardReady)) { throw "Skill-loader rollback guard did not become ready" }
  $skillLoaderSnapshotCommitted = $true
}
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $sessionTitleExtension spawn-guard $sessionTitleSnapshot $puiVersion $ScriptDir 2>&1 | Out-Null; $sessionTitleGuardExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($sessionTitleGuardExit -eq 75 -or $sessionTitleGuardExit -eq 76) {
  $sessionTitleSnapshotCommitted = $true
  Remove-Item $sessionTitleSnapshot -Recurse -Force
  $sessionTitleSnapshot = $null
} elseif ($sessionTitleGuardExit -ne 0) {
  throw "Could not start the outer-transaction session-title rollback guard"
} else {
  $sessionTitleGuardReady = Join-Path $sessionTitleSnapshot "guard-ready"
  for ($guardWait = 0; $guardWait -lt 50 -and -not (Test-Path $sessionTitleGuardReady); $guardWait += 1) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path $sessionTitleGuardReady)) { throw "Session-title rollback guard did not become ready" }
  $sessionTitleSnapshotCommitted = $true
}
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $reasoningPatch spawn-guard $reasoningSnapshot $puiVersion $ScriptDir $reasoningPiWebRoot $reasoningStandaloneRoot 2>&1 | Out-Null; $reasoningGuardExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($reasoningGuardExit -eq 75 -or $reasoningGuardExit -eq 76) {
  $reasoningPatchCommitted = $true
  Remove-Item $reasoningSnapshot -Recurse -Force
  $reasoningSnapshot = $null
} elseif ($reasoningGuardExit -ne 0) {
  throw "Could not start the outer-transaction reasoning-summary rollback guard"
} else {
  $reasoningGuardReady = Join-Path $reasoningSnapshot "guard-ready"
  for ($guardWait = 0; $guardWait -lt 50 -and -not (Test-Path $reasoningGuardReady); $guardWait += 1) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path $reasoningGuardReady)) { throw "Reasoning-summary rollback guard did not become ready" }
  $reasoningPatchCommitted = $true
}

Write-Host "`nUpdate complete: all doctor checks passed." -ForegroundColor Green
} finally {
  if ($sessionTitleSnapshot -and -not $sessionTitleSnapshotCommitted) {
    $sessionTitleSnapshotResolved = $false
    $previousPreference = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & node $sessionTitleExtension restore-snapshot $sessionTitleSnapshot $ScriptDir 2>&1 | Out-Null; $sessionTitleRestoreExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previousPreference }
    if ($sessionTitleRestoreExit -eq 0) { $sessionTitleSnapshotResolved = $true }
    else { Write-Host "  FAILED to restore PUI session-title extension; recovery snapshot retained at $sessionTitleSnapshot" -ForegroundColor Red }
    if ($sessionTitleSnapshotResolved) { Remove-Item $sessionTitleSnapshot -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if ($skillLoaderSnapshot -and -not $skillLoaderSnapshotCommitted) {
    $skillLoaderSnapshotResolved = $false
    $previousPreference = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & node $skillLoaderExtension restore-snapshot $skillLoaderSnapshot $ScriptDir 2>&1 | Out-Null; $skillLoaderRestoreExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previousPreference }
    if ($skillLoaderRestoreExit -eq 0) { $skillLoaderSnapshotResolved = $true }
    else { Write-Host "  FAILED to restore PUI skill-loader extension; recovery snapshot retained at $skillLoaderSnapshot" -ForegroundColor Red }
    if ($skillLoaderSnapshotResolved) { Remove-Item $skillLoaderSnapshot -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if ($reasoningSnapshot -and -not $reasoningPatchCommitted) {
    $reasoningSnapshotResolved = $false
    $previousPreference = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & node $reasoningPatch restore-snapshot $reasoningSnapshot $ScriptDir $reasoningPiWebRoot $reasoningStandaloneRoot 2>&1 | Out-Null; $reasoningRestoreExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previousPreference }
    if ($reasoningRestoreExit -eq 0) { $reasoningSnapshotResolved = $true }
    else { Write-Host "  FAILED to restore Responses reasoning-summary artifacts; recovery snapshot retained at $reasoningSnapshot" -ForegroundColor Red }
    if ($reasoningSnapshotResolved) { Remove-Item $reasoningSnapshot -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if ($subagentsSnapshot -and -not $subagentsPatchCommitted) {
    $subagentsSnapshotResolved = $false
    $previousPreference = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & node $subagentsPatch restore-snapshot $subagentsSnapshot 2>&1 | Out-Null; $subagentsRestoreExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previousPreference }
    if ($subagentsRestoreExit -eq 0) { $subagentsSnapshotResolved = $true }
    else { Write-Host "  FAILED to restore pi-subagents prompt artifacts; recovery snapshot retained at $subagentsSnapshot" -ForegroundColor Red }
    if ($subagentsSnapshotResolved) { Remove-Item $subagentsSnapshot -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if ($backgroundSnapshot -and -not $backgroundPatchCommitted) {
    $backgroundSnapshotResolved = $false
    $previousPreference = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & node $backgroundPatch restore-snapshot $backgroundSnapshot 2>&1 | Out-Null; $backgroundRestoreExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previousPreference }
    if ($backgroundRestoreExit -eq 0) { $backgroundSnapshotResolved = $true }
    else { Write-Host "  FAILED to restore pi-background-tasks compatibility artifacts; recovery snapshot retained at $backgroundSnapshot" -ForegroundColor Red }
    if ($backgroundSnapshotResolved) { Remove-Item $backgroundSnapshot -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Wait-IfInteractive
}
