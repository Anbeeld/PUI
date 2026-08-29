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
$askUserConfig = (& node $Lib "resolve-config-path" ([string]$Stack.configPaths.askUserQuestion) ([string]$Stack.askUserQuestion.configRelativePath) 2>&1 | Select-Object -Last 1).ToString().Trim()
if ($LASTEXITCODE -ne 0) { Write-Host "  ask-user-question config path resolution failed" -ForegroundColor Red; exit 1 }

# The installed transaction worker may predate this patch. Keep a target-script
# snapshot so an introducing update can still restore these non-JSON artifacts.
$backgroundPatch = Join-Path $ScriptDir "lib\pui-background-tasks-patch.js"
$backgroundSnapshot = Join-Path ([System.IO.Path]::GetTempPath()) ("pui-background-task-" + [guid]::NewGuid().ToString("N"))
$backgroundPatchCommitted = $false
New-Item -ItemType Directory -Path $backgroundSnapshot -Force | Out-Null
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $backgroundPatch snapshot $backgroundSnapshot 2>&1 | Out-Null; $backgroundSnapshotExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($backgroundSnapshotExit -ne 0) {
  Remove-Item $backgroundSnapshot -Recurse -Force -ErrorAction SilentlyContinue
  $backgroundSnapshot = $null
  Write-Host "  could not snapshot pi-background-tasks prompt artifacts; update aborted" -ForegroundColor Red
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
  Write-Host "  could not snapshot pi-subagents prompt artifacts; update aborted" -ForegroundColor Red
  exit 1
}

$backupFiles = @()
foreach ($f in @($piWebAccess, $mcpShared, $piSettings, $piFffFeatures, $piGoalSettings, $askUserConfig, $puiSubagentsConfig) | Where-Object { Test-Path $_ }) {
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
      & node (Join-Path $ScriptDir "lib\pui-web-integration.js") apply $ScriptDir $piWebPkgRoot 2>&1 | ForEach-Object { Write-Host "    $_" }
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
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & pi remove $spec 2>&1 | ForEach-Object { Write-Host "    $_" }; $piExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
    if ($piExit -ne 0) { Write-Host "  failed to retire $spec" -ForegroundColor Red; exit 1 }
    $installedPackages = @($installedPackages | Where-Object { $_ -ne $spec -and -not $_.StartsWith("$spec@") })
  }
}
foreach ($spec in @($Stack.piPackages)) {
  Write-Host "  reconciling managed extension $spec..."
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & pi install $spec 2>&1 | ForEach-Object { Write-Host "    $_" }; $piExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
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
if ($backgroundPatchExit -ne 0) { Write-Host "  pi-background-tasks compact prompt patch could not be applied (version or metadata drift); update aborted." -ForegroundColor Red; exit 1 }
Write-Host "  pi-background-tasks compact model guidance applied"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $subagentsPatch apply 2>&1 | Out-Null; $subagentsPatchExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($subagentsPatchExit -ne 0) { Write-Host "  pi-subagents model policy patch could not be applied (version or metadata drift); update aborted." -ForegroundColor Red; exit 1 }
Write-Host "  pi-subagents model policy applied"

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
$mcFooterCfg = '{"settings":{"mcpFooterStatus":"off"}}'
$mcFooterFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($mcFooterFile, $mcFooterCfg, [System.Text.UTF8Encoding]::new($false))
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $Lib "merge-object" $mcpShared "@$mcFooterFile" 2>&1 | Out-Null; $mcFooterExit = $LASTEXITCODE }
finally { Remove-Item $mcFooterFile -Force -ErrorAction SilentlyContinue; $ErrorActionPreference = $prev }
if ($mcFooterExit -ne 0) { Write-Host "  MCP footer status reconciliation failed" -ForegroundColor Red; exit 1 }
Write-Host "  MCP footer status hidden (mcpFooterStatus=off)"
Assert-NoInjectedFailure "config-migration"
& node (Join-Path $ScriptDir "lib\pui-update-extension.js") install $ScriptDir | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "  PUI update extension replacement failed" -ForegroundColor Red; exit 1 }
Assert-NoInjectedFailure "extension-replacement"

# 6. refresh model catalogs
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & pi update --models 2>&1 | ForEach-Object { Write-Host "    $_" }; $modelsExit = $LASTEXITCODE } catch { Write-Host "  pi update --models failed: $_" -ForegroundColor Red; $modelsExit = 1 }
finally { $ErrorActionPreference = $prev }
if ($modelsExit -ne 0) { Write-Host "  model catalog refresh failed" -ForegroundColor Red; exit 1 }

# 7. managed pins converge to stack.json; unrelated package pins are preserved.

# 8. do not rewrite web/MCP config unless schema migration required (not in v1)

# 9. restart pi-web if autostart enabled (Startup-folder VBS launcher, not Task Scheduler)
$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherVbs = Join-Path $startupFolder "pui-piweb.vbs"
if (Test-Path $launcherVbs) {
  Write-Host "  restarting pi-web (autostart launcher present)..."
  # Stop any running pi-web node process so the new binary is picked up.
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    foreach ($pidToStop in @(Get-PiWebPid)) { Write-Host "    stopping pi-web node (PID $pidToStop)"; Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue }
    if (-not (Wait-PiWebStopped)) {
      Write-Host "  could not stop Pi Web before restart; update aborted" -ForegroundColor Red
      exit 1
    }
    # Re-launch pi-web through the same hidden VBS launcher the autostart uses.
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
      Start-Process -FilePath "wscript.exe" -ArgumentList "`"$launcherVbs`"" | Out-Null
      Write-Host "    pi-web launch requested via autostart launcher"
      # Require two consecutive HTTP 200 responses so a stale or short-lived
      # process cannot pass this gate before the doctor smoke suite runs.
      if (-not (Wait-PiWebHealthy)) { Write-Host "  pi-web did not reach stable running state with HTTP 200 within 60s" -ForegroundColor Red; exit 1 }
      Write-Host "    pi-web restarted via autostart launcher and is running and healthy at $($Stack.piWeb.url)"
    }
  } finally { $ErrorActionPreference = $prev }
} else {
  Write-Host "  no autostart launcher found; skipping pi-web restart"
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

Write-Host "`nUpdate complete: all doctor checks passed." -ForegroundColor Green
} finally {
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
    else { Write-Host "  FAILED to restore pi-background-tasks prompt artifacts; recovery snapshot retained at $backgroundSnapshot" -ForegroundColor Red }
    if ($backgroundSnapshotResolved) { Remove-Item $backgroundSnapshot -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Wait-IfInteractive
}
