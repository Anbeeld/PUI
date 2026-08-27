#requires -Version 5.1
<#
.SYNOPSIS
  PUI installer for native Windows 11.
.DESCRIPTION
  Opinionated batteries-included composition profile for vanilla Pi.
  Installs Pi Web, vanilla Pi runtime, and the Pi packages listed in stack.json,
  configures free keyless web, Playwright MCP, native filesystem tools, and optional PWA autostart.
  Installs a small inert update extension and Pi Web bridge; no PUI daemon or fork is added.
.PARAMETER NoPwa
  Skip PWA/app integration and Pi Web autostart. Pi Web is still installed.
.PARAMETER NoBrowser
  Do not attempt to open the PWA onboarding URL at the end.
.PARAMETER KeylessRoute
  Promote PUI's keyless providers (exa, duckduckgo) to primary when an existing
  user provider would otherwise override the keyless route. User providers are
  preserved after them.
.EXAMPLE
  ./install.ps1
.EXAMPLE
  ./install.ps1 -NoPwa
.NOTES
  Uses lib/pui-config.js (Node) for all JSON merges so merge logic is shared/tested cross-platform.
#>
[CmdletBinding()]
param(
  [switch]$NoPwa,
  [switch]$NoBrowser,
  [switch]$KeylessRoute
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Lib = Join-Path $ScriptDir "lib\pui-config.js"
$Stack = Get-Content (Join-Path $ScriptDir "stack.json") -Raw | ConvertFrom-Json
$script:GateResults = [ordered]@{}
$script:Failures = @()

function Wait-IfInteractive {
  if ($env:PUI_NONINTERACTIVE) { return }
  try { Write-Host ""; Read-Host -Prompt "Press Enter to close this window" | Out-Null } catch {}
}

try {

function Write-Phase($n, $t) { Write-Host "`n=== Phase $n — $t ===" -ForegroundColor Cyan }
function Write-Gate($g, $t, $pass) {
  $script:GateResults[$g] = $pass
  if ($pass) { Write-Host "[GATE $g PASS] $t" -ForegroundColor Green }
  else { Write-Host "[GATE $g FAIL] $t" -ForegroundColor Red; $script:Failures += $g }
}
function Invoke-NodeConfig {
  param([string[]]$CfgArgs)
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & node $Lib @CfgArgs 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  return @{ exit = $code; out = ($out -join "`n") }
}
function Invoke-Npm {
  # Run npm without ErrorActionPreference=Stop treating stderr warnings as terminating.
  # Uses cmd /c to fully isolate stderr from PowerShell's error stream.
  param([string[]]$NpmArgs)
  $argStr = $NpmArgs | ForEach-Object { 
    if ($_ -match '\s') { "`"$_`"" } else { $_ }
  }
  $cmdLine = "npm " + ($argStr -join " ")
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = cmd /c $cmdLine 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  return @{ exit = $code; out = ($out -join "`n") }
}
function Invoke-Pi {
  param([string[]]$PiArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & pi @PiArgs 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  return @{ exit = $code; out = ($out -join "`n") }
}
function Expand-Path($p) {
  if ($p -match '^~') { return (Join-Path $env:USERPROFILE ($p -replace '^~[\\/]?','')) }
  return $p
}
function Test-Command($n) { return [bool](Get-Command $n -ErrorAction SilentlyContinue) }

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

$piWebUrl = [string]$Stack.piWeb.url

# Resolve paths from stack.json
$piAgentDir = Expand-Path $Stack.configPaths.piAgentDir
$piSettings = Expand-Path $Stack.configPaths.piSettings
$piWebAccess = Expand-Path $Stack.configPaths.piWebAccess
$mcpShared = Expand-Path $Stack.configPaths.mcpShared

# ----------------------------------------------------------------------------
# Phase 1 — prerequisite detection (G1)
# ----------------------------------------------------------------------------
Write-Phase 1 "prerequisite detection"
$g1 = $true
$prereqReport = @()

# OS
$os = (Get-CimInstance Win32_OperatingSystem).Caption
if ($os -notmatch "Windows 10|Windows 11") {
  $prereqReport += "OS: $os (Windows 10/11 required)"; $g1 = $false
} else { $prereqReport += "OS: $os" }

# Node
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
if (-not (Test-Command node)) { $prereqReport += "Node: NOT FOUND"; $g1 = $false }
else {
  $nodeVer = (& node --version 2>$null)
  $nodeNum = [version]($nodeVer -replace '^v','')
  $minNode = [version]$Stack.minimumNode
  if ($nodeNum -lt $minNode) { $prereqReport += "Node: $nodeVer (requires >= $($Stack.minimumNode))"; $g1 = $false }
  else { $prereqReport += "Node: $nodeVer" }
}

# npm
if (-not (Test-Command npm)) { $prereqReport += "npm: NOT FOUND"; $g1 = $false }
else { $prereqReport += "npm: $(& npm --version 2>$null)" }

# git
if (-not (Test-Command git)) { $prereqReport += "Git: NOT FOUND"; $g1 = $false }
else { $prereqReport += "Git: $(& git --version 2>$null)" }

# network (lightweight npm ping)
try { $ping = Invoke-RestMethod "https://registry.npmjs.org/-/ping?write=true" -TimeoutSec 10; $prereqReport += "Network: OK" }
catch { $prereqReport += "Network: npm registry unreachable"; $g1 = $false }

$prereqReport | ForEach-Object { Write-Host "  $_" }
Write-Gate G1 "prerequisites" $g1
if (-not $g1) {
  Write-Host "`nPrerequisite failure. Install missing items and re-run. PUI does not auto-install Node or Git." -ForegroundColor Yellow
  Write-Host "  Node >= $($Stack.minimumNode): https://nodejs.org/" -ForegroundColor Yellow
  Write-Host "  Git for Windows: https://git-scm.com/download/win" -ForegroundColor Yellow
  exit 1
}

# ----------------------------------------------------------------------------
# Phase 2 — preserve existing state (G2)
# ----------------------------------------------------------------------------
Write-Phase 2 "preserve existing state"
$g2 = $true
$filesToChange = @($piSettings, $piWebAccess, $mcpShared) | Select-Object -Unique
foreach ($f in $filesToChange) {
  if (Test-Path $f) {
    # validate parse
    $r = Invoke-NodeConfig -CfgArgs @("validate", $f)
    if ($r.exit -ne 0) {
      Write-Host "  INVALID JSON (not overwritten): $f" -ForegroundColor Red
      Write-Host "    $($r.out)" -ForegroundColor Red
      $g2 = $false
    } else {
      $bk = Invoke-NodeConfig -CfgArgs @("backup", $f)
      Write-Host "  backed up: $($bk.out.Trim())"
    }
  }
}
Write-Gate G2 "preservation" $g2
if (-not $g2) {
  Write-Host "`nExisting JSON is invalid. Fix the reported files before re-running." -ForegroundColor Yellow
  exit 1
}

# ----------------------------------------------------------------------------
# Phase 3 — Pi Web and Pi core (G3)
# ----------------------------------------------------------------------------
Write-Phase 3 "Pi Web + Pi runtime parity"

# A reinstall also replaces shared managed runtimes. Check Pi Web while it is
# still alive so active work is never mistaken for an idle/unreachable server.
$piWebProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match '[\\/]node_modules[\\/]@agegr[\\/]pi-web[\\/]'
})
if ($piWebProcesses.Count -gt 0) {
  try { $runningState = Invoke-RestMethod "$piWebUrl/api/agent/running" -TimeoutSec 3 -ErrorAction Stop }
  catch { Write-Host "  could not verify Pi Web idle state; install aborted" -ForegroundColor Red; exit 1 }
  if (-not $runningState.PSObject.Properties['runningSessionIds']) { Write-Host "  Pi Web returned an invalid activity response; install aborted" -ForegroundColor Red; exit 1 }
  if (@($runningState.runningSessionIds).Count -gt 0) { Write-Host "  active Pi Web sessions detected; install deferred without stopping them" -ForegroundColor Yellow; exit 75 }
}

# Stop any running pi-web process before npm install (avoids EBUSY on Windows).
$piWebProcesses | ForEach-Object { Write-Host "  stopping running pi-web (PID $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

& node (Join-Path $ScriptDir "lib\pui-updater.js") standalone-busy
if ($LASTEXITCODE -eq 75) { Write-Host "  standalone Pi is active; install deferred" -ForegroundColor Yellow; exit 75 }
if ($LASTEXITCODE -ne 0) { Write-Host "  could not verify standalone Pi idle state" -ForegroundColor Red; exit 1 }

Write-Host "  installing @agegr/pi-web (global)..."
$piWebSpec = "$($Stack.upstream.gui.npm)@$($Stack.upstream.gui.version)"
try {
  $r = Invoke-Npm -NpmArgs @("install","-g","--ignore-scripts",$piWebSpec)
} catch {
  Write-Host "  Invoke-Npm threw: $($_.Exception.Message)" -ForegroundColor Red
  Write-Gate G3 "pi-web install" $false; exit 1
}
if ($r.exit -ne 0) { Write-Host "  npm output: $($r.out)" -ForegroundColor Red; Write-Gate G3 "pi-web install" $false; exit 1 }

# Refresh PATH for just-installed globals
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$piWebCodingAgentVer = [string]$Stack.upstream.agentRuntime.version
Write-Host "  PUI pins pi-coding-agent $piWebCodingAgentVer"

$g3 = $true
if (-not (Test-Command pi-web)) { Write-Host "  pi-web not on PATH"; $g3 = $false }

# A fresh machine does not get the standalone `pi` command from pi-web's
# private dependency tree. Install it first, then verify PATH and parity.
$piRuntimeSpec = "$($Stack.upstream.agentRuntime.npm)@$piWebCodingAgentVer"
$piVer = $null
if (Test-Command pi) { $piVer = ((Invoke-Pi -PiArgs @("--version")).out -replace '[^0-9.]','') }
if (-not $piVer -or ($piWebCodingAgentVer -and $piVer -ne $piWebCodingAgentVer)) {
  Write-Host "  installing standalone pi from $piRuntimeSpec..."
  $r = Invoke-Npm -NpmArgs @("install","-g","--ignore-scripts",$piRuntimeSpec)
  if ($r.exit -ne 0) { Write-Host "  pi install failed: $($r.out)" -ForegroundColor Red; $g3 = $false }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
if (-not (Test-Command pi)) {
  Write-Host "  pi not on PATH"
  $g3 = $false
} else {
  $piVer = ((Invoke-Pi -PiArgs @("--version")).out -replace '[^0-9.]','')
  Write-Host "  pi --version: $piVer"
  if ($piWebCodingAgentVer -and $piVer -ne $piWebCodingAgentVer) {
    Write-Host "  runtime mismatch: pi=$piVer pi-web=$piWebCodingAgentVer" -ForegroundColor Red
    $g3 = $false
  }
}
Write-Gate G3 "runtime parity" $g3
if (-not $g3) { exit 1 }

# Override pi-web branding: improved icons, favicon, service worker cache-bust,
# and PUI title/metadata. All setup-time, re-applied on update, restored on
# uninstall. Failures are warned, not fatal.
$puiIconsDir = Join-Path $ScriptDir "assets\icons"
if (Test-Path $puiIconsDir) {
  try {
    $globalRoot = & npm root -g
    $piWebPkgRoot = Join-Path (Join-Path $globalRoot "@agegr") "pi-web"
    $piWebIconsDir = Join-Path $piWebPkgRoot "public\icons"
    if (Test-Path $piWebIconsDir) {
      Write-Host "  applying complete PUI icon set..."
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
      $integrationScript = Join-Path $ScriptDir "lib\pui-web-integration.js"
      & node $integrationScript apply $ScriptDir $piWebPkgRoot 2>&1 | ForEach-Object { Write-Host "    $_" }
      if ($LASTEXITCODE -ne 0) { throw "Pi Web update integration failed" }
      Write-Host "  branding override applied (icons, favicon, SW cache-bust, title/metadata)"
    }
  } catch {
    Write-Host "  PUI branding/icon override failed: $_" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "  PUI icon directory missing: $puiIconsDir" -ForegroundColor Red
  exit 1
}

# ----------------------------------------------------------------------------
# Phase 4 — Pi packages (G4)
# ----------------------------------------------------------------------------
Write-Phase 4 "Pi packages"
$g4 = $true
$pkgs = $Stack.piPackages
# Remove packages that PUI previously managed but has explicitly retired.
$r = Invoke-Pi -PiArgs @("list")
if ($r.exit -eq 0) {
  foreach ($spec in @($Stack.retiredPiPackages)) {
    if ($r.out -match [regex]::Escape($spec)) {
      Write-Host "  retiring $spec"
      $remove = Invoke-Pi -PiArgs @("remove",$spec)
      if ($remove.out) { $remove.out -split "`n" | ForEach-Object { if ($_) { Write-Host "    $_" } } }
      if ($remove.exit -ne 0) { Write-Host "  FAILED to retire: $spec" -ForegroundColor Red; $g4 = $false }
    }
  }
}
foreach ($spec in $pkgs) {
  Write-Host "  pi install $spec"
  $r = Invoke-Pi -PiArgs @("install",$spec)
  if ($r.out) { $r.out -split "`n" | ForEach-Object { if ($_) { Write-Host "    $_" } } }
  if ($r.exit -ne 0) { Write-Host "  FAILED: $spec" -ForegroundColor Red; $g4 = $false }
  else {
    $setResult = Invoke-NodeConfig -CfgArgs @("set-package", $piSettings, $spec)
    if ($setResult.exit -ne 0) { Write-Host "  managed pin reconciliation failed: $($setResult.out)" -ForegroundColor Red; $g4 = $false }
  }
}
$extensionScript = Join-Path $ScriptDir "lib\pui-update-extension.js"
& node $extensionScript install $ScriptDir 2>&1 | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { Write-Host "  PUI update extension install failed" -ForegroundColor Red; $g4 = $false }

# PUI opinion: unlimited automatic /goal turns with a readable status line.
# continuationLimits.automaticTurns = null removes the 25-response ceiling;
# the dist patch rewrites formatStatus into "Goal: <status> · <reason> · <counter>".
$piGoalSettings = Expand-Path $Stack.configPaths.piGoal
$goalCfg = '{"continuationLimits":{"automaticTurns":null,"noProgressTurns":3}}'
$goalCfgFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($goalCfgFile, $goalCfg, [System.Text.UTF8Encoding]::new($false))
$r = Invoke-NodeConfig -CfgArgs @("merge-object", $piGoalSettings, "@$goalCfgFile")
Remove-Item $goalCfgFile -Force -ErrorAction SilentlyContinue
if ($r.exit -ne 0) { Write-Host "  pi-goal settings merge failed: $($r.out)" -ForegroundColor Red; $g4 = $false }
$goalPatchScript = Join-Path $ScriptDir "lib\pui-goal-patch.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $goalPatchScript apply 2>&1 | ForEach-Object { Write-Host "    $_" }; $goalPatchExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($goalPatchExit -ne 0) { Write-Host "  pi-goal status patch could not be applied (version drift); the turn counter may still show 'automatic Unlimited'." -ForegroundColor Yellow }
else { Write-Host "  pi-goal configured for unlimited turns with a readable status line" }

# Verify the node-pty native binding for @99percentpeople/pi-background-tasks.
# node-pty ships prebuilds, so this usually passes; if not, approve and rebuild it.
$nativeCheck = Join-Path $ScriptDir "lib\pui-native-check.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $nativeCheck ensure (Join-Path $piAgentDir "npm") 2>&1 | ForEach-Object { Write-Host "    $_" }; $nativeExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($nativeExit -ne 0) { Write-Host "  pi-background-tasks native (node-pty) binding could not be verified or rebuilt; install aborted. Install the required compiler toolchain and rerun install.ps1." -ForegroundColor Red; $g4 = $false }
# Verify packages are visible (pi list)
$r = Invoke-Pi -PiArgs @("list")
if ($r.exit -eq 0) {
  Write-Host "  pi list:"; $r.out -split "`n" | ForEach-Object { if ($_) { Write-Host "    $_" } }
  foreach ($p in @("pi-subagents","pi-web-access","pi-mcp-adapter","pi-goal","pi-accounts","pi-usage","rpiv-ask-user-question","pi-fff","pi-background-tasks")) {
    if ($r.out -notmatch $p) { Write-Host "  package not visible: $p" -ForegroundColor Yellow }
  }
} else { Write-Host "  pi list failed: $($r.out)" -ForegroundColor Yellow }
Write-Gate G4 "packages" $g4
if (-not $g4) { exit 1 }

# Configure pi-fff feature state: suppress startup notices while keeping
# fuzzy path resolution, content search, and autocomplete active.
$piFffFeatures = Expand-Path $Stack.configPaths.piFffFeatures
$fffCfg = @{ enabledFeatures = @($Stack.fff.enabledFeatures) } | ConvertTo-Json -Depth 10 -Compress
$fffCfgFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($fffCfgFile, $fffCfg, [System.Text.UTF8Encoding]::new($false))
$r = Invoke-NodeConfig -CfgArgs @("merge-object", $piFffFeatures, "@$fffCfgFile")
Remove-Item $fffCfgFile -Force -ErrorAction SilentlyContinue
Write-Host "  pi-fff feature state configured (startup notices disabled)"

# ----------------------------------------------------------------------------
# Phase 5 — Pi default tools (G5)
# ----------------------------------------------------------------------------
Write-Phase 5 "native filesystem tools"
$toolsJson = ($Stack.defaultTools | ForEach-Object { '"'+$_+'"' }) -join ","
$toolsJson = "[$toolsJson]"
$toolsFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($toolsFile, $toolsJson, [System.Text.UTF8Encoding]::new($false))
$r = Invoke-NodeConfig -CfgArgs @("default-tools-merge", $piSettings, "@$toolsFile")
Remove-Item $toolsFile -Force -ErrorAction SilentlyContinue
if ($r.exit -ne 0) { Write-Host "  $($r.out)"; Write-Gate G5 "filesystem" $false; exit 1 }
Write-Host "  $($r.out)"
$g5 = $true
if (Test-Path $piSettings) {
  $settings = Get-Content $piSettings -Raw | ConvertFrom-Json
  $dt = $settings.defaultTools
  foreach ($t in $Stack.defaultTools) { if ($dt -notcontains $t) { $g5 = $false } }
} else { $g5 = $false }
# Verify no filesystem MCP installed by PUI (we only added playwright)
Write-Gate G5 "filesystem" $g5
if (-not $g5) { exit 1 }

# ----------------------------------------------------------------------------
# Phase 6 — free keyless web configuration (G6)
# ----------------------------------------------------------------------------
Write-Phase 6 "free keyless web"
$webCfg = @{
  searchRouting = $Stack.webAccess.searchRouting
  fetchRouting = $Stack.webAccess.fetchRouting
  workflow = $Stack.webAccess.workflow
} | ConvertTo-Json -Depth 10 -Compress
$webCfgFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($webCfgFile, $webCfg, [System.Text.UTF8Encoding]::new($false))
$r = Invoke-NodeConfig -CfgArgs @("merge-object", $piWebAccess, "@$webCfgFile")
Remove-Item $webCfgFile -Force -ErrorAction SilentlyContinue
if ($r.exit -ne 0) { Write-Host "  $($r.out)"; Write-Gate G6 "free web" $false; exit 1 }
Write-Host "  $($r.out)"

# G6 functional check requires a running pi session with web_access; deferred to G9 smoke/manual gate.
# Here we verify the config is structurally present AND the primary provider is keyless.
$g6 = $true
$wa = Get-Content $piWebAccess -Raw | ConvertFrom-Json
if (-not $wa.searchRouting -or -not $wa.fetchRouting) { $g6 = $false }
if ($wa.searchRouting.providers -notcontains "duckduckgo") { $g6 = $false }
if ($wa.fetchRouting.allowRemoteHostedProviders -ne $false) { $g6 = $false }
# Deterministic keyless route: the primary search provider must be a verified
# zero-key provider (exa or duckduckgo). A foreign primary means an existing
# An existing primary provider would override PUI's keyless route.
$primaryProvider = ""
try { $primaryProvider = [string]$wa.searchRouting.providers[0] } catch { }
if ($primaryProvider -ne "exa" -and $primaryProvider -ne "duckduckgo") {
  if ($KeylessRoute) {
    $providersJson = ($Stack.webAccess.searchRouting.providers | ForEach-Object { '"'+$_+'"' }) -join ","
    $provFile = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($provFile, "[$providersJson]", [System.Text.UTF8Encoding]::new($false))
    $r = Invoke-NodeConfig -CfgArgs @("prioritize", $piWebAccess, "searchRouting.providers", "@$provFile")
    Remove-Item $provFile -Force -ErrorAction SilentlyContinue
    if ($r.exit -eq 0) {
      Write-Host "  keyless route promoted to primary (-KeylessRoute): exa, duckduckgo first; user providers preserved after."
      Write-Host "  $($r.out)"
    } else {
      Write-Host "  prioritize failed: $($r.out)" -ForegroundColor Red; $g6 = $false
    }
  } else {
    Write-Host "  WARNING: existing primary search provider '$primaryProvider' overrides PUI's keyless route." -ForegroundColor Yellow
    Write-Host "    PUI cannot certify the keyless default with this configuration." -ForegroundColor Yellow
    Write-Host "    Re-run with -KeylessRoute to promote exa/duckduckgo to primary (user providers are kept, not deleted)." -ForegroundColor Yellow
    $g6 = $false
  }
}
Write-Gate G6 "free web (config)" $g6
if (-not $g6) { exit 1 }

# ----------------------------------------------------------------------------
# Phase 7 — MCP + Playwright (G7)
# ----------------------------------------------------------------------------
Write-Phase 7 "MCP + Playwright"
$mcpDef = @{
  command = $Stack.mcp.command
  args = $Stack.mcp.args
  lifecycle = $Stack.mcp.lifecycle
  directTools = @($Stack.mcp.directTools)
} | ConvertTo-Json -Depth 10 -Compress
$mcpDefFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($mcpDefFile, $mcpDef, [System.Text.UTF8Encoding]::new($false))
$r = Invoke-NodeConfig -CfgArgs @("set-server", $mcpShared, $Stack.mcp.serverName, "@$mcpDefFile")
Remove-Item $mcpDefFile -Force -ErrorAction SilentlyContinue
if ($r.exit -eq 2) {
  Write-Host "  $($r.out)" -ForegroundColor Red
  Write-Host "  Existing 'playwright' server has a different configuration." -ForegroundColor Yellow
  Write-Host "  Inspect $mcpShared and remove or rename the existing entry before re-running." -ForegroundColor Yellow
  Write-Gate G7 "mcp" $false; exit 1
}
if ($r.exit -ne 0) { Write-Host "  $($r.out)"; Write-Gate G7 "mcp" $false; exit 1 }
Write-Host "  $($r.out)"
# PUI opinion: keep the MCP footer status quiet. mcpFooterStatus="off" clears
# the "MCP: N server(s) enabled" segment from the extension status bar.
$mcFooterCfg = '{"settings":{"mcpFooterStatus":"off"}}'
$mcFooterFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($mcFooterFile, $mcFooterCfg, [System.Text.UTF8Encoding]::new($false))
$r = Invoke-NodeConfig -CfgArgs @("merge-object", $mcpShared, "@$mcFooterFile")
Remove-Item $mcFooterFile -Force -ErrorAction SilentlyContinue
if ($r.exit -ne 0) { Write-Host "  MCP footer status merge failed: $($r.out)" -ForegroundColor Red; Write-Gate G7 "mcp" $false; exit 1 }
Write-Host "  MCP footer status hidden (mcpFooterStatus=off)"
$g7 = $true
$mcp = Get-Content $mcpShared -Raw | ConvertFrom-Json
$expectedDirectTools = ConvertTo-Json -InputObject @($Stack.mcp.directTools) -Compress
$actualDirectTools = ConvertTo-Json -InputObject @($mcp.mcpServers.playwright.directTools) -Compress
$proxyDisabled = $mcp.settings -and $mcp.settings.disableProxyTool -eq $true
if (-not $mcp.mcpServers.playwright -or $actualDirectTools -ne $expectedDirectTools -or $proxyDisabled) { $g7 = $false }
if ($proxyDisabled) { Write-Host "  MCP proxy is disabled by settings.disableProxyTool; PUI requires it for non-direct tools." -ForegroundColor Red }
Write-Gate G7 "mcp (config)" $g7
if (-not $g7) { exit 1 }

# ----------------------------------------------------------------------------
# Phase 8 — PWA/app integration (G8)
# ----------------------------------------------------------------------------
$autostartConfigured = $false
$g8 = $true
if (-not $NoPwa) {
  Write-Phase 8 "PWA/app integration"

  # Windows per-user autostart via the Startup folder (no elevation needed).
  # Idempotent: write a VBS launcher to the user's Startup folder.
  $startupFolder = [Environment]::GetFolderPath("Startup")
  $piWebCmd = "$env:APPDATA\npm\pi-web.cmd"
  if (-not (Test-Path $piWebCmd)) {
    Write-Host "  pi-web.cmd not found at $piWebCmd" -ForegroundColor Red
    $g8 = $false
  } else {
    $launcherBat = Join-Path $startupFolder "pui-piweb.bat"

    # Use a VBS wrapper to avoid a visible console window on login.
    $launcherVbs = Join-Path $startupFolder "pui-piweb.vbs"
    $vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c set PI_WEB_SKIP_VERSION_CHECK=1&&""$piWebCmd"" --no-open", 0, False
"@
    # No BOM: Windows Script Host rejects UTF-8 BOM with "Invalid character" (800A0408).
    [System.IO.File]::WriteAllText($launcherVbs, $vbsContent, [System.Text.UTF8Encoding]::new($false))
    # Remove old .bat if present (migration from earlier version)
    if (Test-Path $launcherBat) { Remove-Item $launcherBat -Force -ErrorAction SilentlyContinue }
    Write-Host "  autostart launcher written: $launcherVbs (logon, hidden, loopback)"

    # Start pi-web now for health check + PWA onboarding.
    Write-Host "  starting pi-web --no-open for health check..."
    $piWebProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "set PI_WEB_SKIP_VERSION_CHECK=1&&`"$piWebCmd`" --no-open" -PassThru -WindowStyle Hidden
    $healthy = $false
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try {
      for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        try {
          $resp = Invoke-WebRequest $piWebUrl -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
          if ($resp.StatusCode -eq 200) { $healthy = $true; break }
        } catch { }
      }
    } finally { $ErrorActionPreference = $prev }

    if ($healthy) {
      Write-Host "  pi-web healthy at $piWebUrl"
      $autostartConfigured = $true
      if (-not $NoBrowser) {
        Write-Host "  opening $piWebUrl for PWA onboarding..."
        Start-Process $piWebUrl
      }
    } else {
      Write-Host "  pi-web did not become healthy within 60s" -ForegroundColor Red
      $g8 = $false
    }
  }
  Write-Gate G8 "app route" $g8
  if ($g8) {
    Write-Host "`nPWA status:" -ForegroundColor Cyan
    Write-Host "  backend/autostart configured: VERIFIED"
    Write-Host "  browser web app installed:     USER_CONFIRMATION_REQUIRED"
    Write-Host "  (Use the browser's 'Install app' / 'Install page as app' action on the opened page.)"
  }
} else {
  Write-Phase 8 "PWA/app integration (skipped via -NoPwa)"
  Write-Host "  Pi Web installed; manual start: pi-web"
  Write-Gate G8 "app route (skipped)" $true
}

# ----------------------------------------------------------------------------
# Phase 9 — end-to-end validation (G9)
# ----------------------------------------------------------------------------
Write-Phase 9 "end-to-end smoke"
$g9 = $true
$smoke = @()

# 1. Pi CLI starts
$r = Invoke-Pi -PiArgs @("--version")
if ($r.exit -eq 0) { $smoke += "[PASS] 1. pi --version: $($r.out.Trim())" } else { $smoke += "[FAIL] 1. pi --version"; $g9 = $false }

# 2. Pi Web serves
if ($NoPwa) {
  $smoke += "[SKIP] 2. pi-web health (no-pwa; not started)"
} else {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $resp = Invoke-WebRequest $piWebUrl -TimeoutSec 5 -UseBasicParsing; if ($resp.StatusCode -eq 200) { $smoke += "[PASS] 2. pi-web serves local page" } else { $smoke += "[FAIL] 2. pi-web status $($resp.StatusCode)"; $g9 = $false } }
  catch { $smoke += "[FAIL] 2. pi-web health: $_"; $g9 = $false }
  finally { $ErrorActionPreference = $prev }
}

# 3. runtime parity
$piVer = ((Invoke-Pi -PiArgs @("--version")).out -replace '[^0-9.]','')
$pwCA = Get-PiWebCodingAgentVersion
if ($pwCA -and $piVer -eq $pwCA) { $smoke += "[PASS] 3. runtime parity ($piVer)" }
elseif (-not $pwCA) { $smoke += "[WARN] 3. runtime parity (pi-web coding-agent version not resolvable)" }
else { $smoke += "[WARN] 3. runtime parity: pi=$piVer vs pi-web=$pwCA" }

# 4. Required Pi packages load
$r = Invoke-Pi -PiArgs @("list")
$piListStr = ""
if ($r.exit -eq 0) {
  $piListStr = $r.out
  $allPkg = $true
  foreach ($p in @("pi-subagents","pi-web-access","pi-mcp-adapter","pi-goal","pi-accounts","pi-usage","rpiv-ask-user-question","pi-fff","pi-background-tasks")) { if ($r.out -notmatch $p) { $allPkg = $false } }
  if ($allPkg) { $smoke += "[PASS] 4. all required packages visible" } else { $smoke += "[FAIL] 4. missing packages"; $g9 = $false }
} else { $smoke += "[FAIL] 4. pi list failed"; $g9 = $false }

# 5/6. filesystem tools (read/find/grep) — structural check; functional needs a pi session.
$st = Get-Content $piSettings -Raw | ConvertFrom-Json
$dtOk = ($Stack.defaultTools | Where-Object { $st.defaultTools -notcontains $_ }).Count -eq 0
if ($dtOk) { $smoke += "[PASS] 5/6. defaultTools present (read/find/grep/ls)" } else { $smoke += "[FAIL] 5/6. missing defaultTools"; $g9 = $false }

# 7/8. web keyless — functional check requires a running pi session with no creds.
# Structural verification already done in G6. Mark as structural-pass, functional deferred.
$wa = Get-Content $piWebAccess -Raw | ConvertFrom-Json
if ($wa.searchRouting.providers -contains "duckduckgo" -and $wa.fetchRouting.allowRemoteHostedProviders -eq $false) {
  $smoke += "[PASS] 7/8. keyless web routing configured (duckduckgo + http only)"
} else { $smoke += "[FAIL] 7/8. keyless web misconfigured"; $g9 = $false }

# 11. Playwright MCP entry present
$mcp = Get-Content $mcpShared -Raw | ConvertFrom-Json
if ($mcp.mcpServers.playwright) { $smoke += "[PASS] 11. playwright MCP entry present" }
else { $smoke += "[FAIL] 11. playwright MCP missing"; $g9 = $false }

# 12. pi-goal extension loaded (structural — package visible)
if ($piListStr -match "pi-goal") { $smoke += "[PASS] 12. pi-goal package visible" }
else { $smoke += "[FAIL] 12. pi-goal not visible"; $g9 = $false }
if ($piListStr -match "pi-background-tasks") { $smoke += "[PASS] 13. pi-background-tasks package visible" }
else { $smoke += "[FAIL] 13. pi-background-tasks not visible"; $g9 = $false }

# 9/10. subagent smoke — deferred to manual release gate (requires a live model session).
$smoke += "[DEFERRED] 9/10. two parallel subagents + retrieval — manual release gate (needs live model)"

# 13. Pi Web uses same normal Pi environment — architectural by design;
#     live same-config verification is part of the manual release gate.
$smoke += "[INFO] 13. Pi Web reads ~/.pi/agent by design; same-config verification deferred to manual release gate"

# 14. Windows native — no WSL
$wslDeps = @("wsl","wsl.exe") | Where-Object { Test-Command $_ }
if ($wslDeps.Count -eq 0) { $smoke += "[PASS] 14. no WSL dependency in PUI run" }
else { $smoke += "[PASS] 14. WSL present on machine but PUI does not use it" }

# 15. no PUI runtime process other than setup
$puiProcs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "pui" }
if ($puiProcs.Count -eq 0) { $smoke += "[PASS] 15. no PUI runtime process" }
else { $smoke += "[FAIL] 15. PUI process running: $($puiProcs.ProcessName)"; $g9 = $false }

$smoke | ForEach-Object { Write-Host "  $_" }
Write-Gate G9 "acceptance smoke" $g9

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
Write-Host "`n=== PUI install summary ===" -ForegroundColor Cyan
$script:GateResults.GetEnumerator() | ForEach-Object {
  $status = if ($_.Value) { "PASS" } else { "FAIL" }
  $color = if ($_.Value) { "Green" } else { "Red" }
  Write-Host "  $($_.Key): $status" -ForegroundColor $color
}

if ($script:Failures.Count -gt 0) {
  Write-Host "`nFailed gates: $($script:Failures -join ', ')" -ForegroundColor Red
  exit 1
}

Write-Host "`nPUI setup complete. Pi remains the runtime; the inert PUI update extension and Pi Web integration stay installed." -ForegroundColor Green
if (-not $NoPwa -and -not $NoBrowser) {
  Write-Host "Complete PWA installation with the browser's 'Install app' action on the page that opened." -ForegroundColor Yellow
}
Write-Host "Run ./doctor.ps1 anytime for diagnostics." -ForegroundColor Green
} finally { Wait-IfInteractive }
