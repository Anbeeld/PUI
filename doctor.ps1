#requires -Version 5.1
<#
.SYNOPSIS
  PUI diagnostics for native Windows. Reports facts; does not mutate by default.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Lib = Join-Path $ScriptDir "lib\pui-config.js"
$Stack = Get-Content (Join-Path $ScriptDir "stack.json") -Raw | ConvertFrom-Json

function Wait-IfInteractive {
  if ($env:PUI_NONINTERACTIVE) { return }
  try { Write-Host ""; Read-Host -Prompt "Press Enter to close this window" | Out-Null } catch {}
}

try {

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

function Expand-Path($p) { if ($p -match '^~') { return (Join-Path $env:USERPROFILE ($p -replace '^~[\\/]?','')) }; return $p }
function Test-Command($n) { return [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Status($label, $state, $detail) {
  if ($state -eq "FAIL") { $script:Fails++ }
  $color = switch ($state) { "PASS" { "Green" } "WARN" { "Yellow" } "FAIL" { "Red" } "NOT CHECKED" { "DarkGray" } "USER ACTION REQUIRED" { "Magenta" } default { "White" } }
  Write-Host ("  {0,-30} {1,-22} {2}" -f $label, $state, $detail) -ForegroundColor $color
}

$piWebUrl = [string]$Stack.piWeb.url
$script:Fails = 0

Write-Host "=== PUI doctor (Windows) ===" -ForegroundColor Cyan

# OS
$os = (Get-CimInstance Win32_OperatingSystem).Caption
Status "OS" "PASS" $os

# Node/npm
if (Test-Command node) {
  $nv = & node --version 2>$null
  $min = [version]$Stack.minimumNode; $cur = [version]($nv -replace '^v','')
  Status "Node" $(if ($cur -ge $min) { "PASS" } else { "FAIL" }) "$nv (min $($Stack.minimumNode))"
} else { Status "Node" "FAIL" "not found" }
Status "npm" $(if (Test-Command npm) { "PASS" } else { "FAIL" }) "$(if (Test-Command npm) { & npm --version } else { 'absent' })"

# Git
Status "Git" $(if (Test-Command git) { "PASS" } else { "FAIL" }) "$(if (Test-Command git) { & git --version } else { 'absent' })"

# Pi version
if (Test-Command pi) { Status "Pi version" "PASS" (& pi --version 2>$null) } else { Status "Pi version" "FAIL" "pi not on PATH" }

# Pi Web version
if (Test-Command pi-web) {
  $pwPkg = Join-Path (Join-Path (Join-Path (& npm root -g) "@agegr") "pi-web") "package.json"
  $pwv = if (Test-Path $pwPkg) { (Get-Content $pwPkg -Raw | ConvertFrom-Json).version } else { "unknown" }
  Status "Pi Web version" $(if ($pwv -eq [string]$Stack.upstream.gui.version) { "PASS" } else { "FAIL" }) "$pwv (expected $($Stack.upstream.gui.version))"
  $piWebPackageRoot = Split-Path $pwPkg -Parent
  $pwCaPkg = Join-Path (Join-Path (Join-Path $piWebPackageRoot "node_modules") "@earendil-works") "pi-coding-agent\package.json"
  $pwCA = if (Test-Path $pwCaPkg) { try { [string](Get-Content $pwCaPkg -Raw | ConvertFrom-Json).version } catch { $null } } else { $null }
  $expectedPi = [string]$Stack.upstream.agentRuntime.version
  Status "Pi Web-resolved Pi" $(if ($pwCA -eq $expectedPi) { "PASS" } else { "FAIL" }) "$(if ($pwCA) { $pwCA } else { 'missing' }) (expected $expectedPi)"
  $piVer = (& pi --version 2>$null) -replace '[^0-9.]',''
  Status "runtime parity" $(if ($piVer -eq $expectedPi -and $pwCA -eq $expectedPi) { "PASS" } else { "FAIL" }) "pi=$piVer pi-web=$(if ($pwCA) { $pwCA } else { 'missing' }) expected=$expectedPi"
} else { Status "Pi Web version" "FAIL" "pi-web not on PATH"; Status "Pi Web-resolved Pi" "NOT CHECKED" ""; Status "runtime parity" "NOT CHECKED" "" }

# Temporary Pi #8782 runtime backport used by Pi Web.
$piWebRoot = if (Test-Command npm) { Join-Path (Join-Path (& npm root -g) "@agegr") "pi-web" } else { "" }
$backportScript = Join-Path $ScriptDir "lib\pui-pi-8782-backport.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $backportScript verify $ScriptDir $piWebRoot 2>&1 | Out-Null; $backportExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
Status "Pi #8782 backport" $(if ($backportExit -eq 0) { "PASS" } else { "FAIL" }) $(if ($backportExit -eq 0) { "Pi Web runtime $($Stack.upstream.agentRuntime.version) patched" } else { "missing or drifted" })
# Display-only Responses reasoning-summary compatibility patch.
$standalonePiRoot = if (Test-Command npm) { Join-Path (& npm root -g) "@earendil-works\pi-coding-agent" } else { "" }
$reasoningPatchScript = Join-Path $ScriptDir "lib\pui-reasoning-summary-patch.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $reasoningPatchScript verify $ScriptDir $piWebRoot $standalonePiRoot 2>&1 | Out-Null; $reasoningPatchExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
Status "reasoning-summary display patch" $(if ($reasoningPatchExit -eq 0) { "PASS" } else { "FAIL" }) $(if ($reasoningPatchExit -eq 0) { "Pi Web and standalone Pi" } else { "missing or drifted" })

# Pi package presence
$piAgentDir = Expand-Path $Stack.configPaths.piAgentDir
$piSettings = Expand-Path $Stack.configPaths.piSettings
$piWebAccess = Expand-Path $Stack.configPaths.piWebAccess
$mcpShared = Expand-Path $Stack.configPaths.mcpShared

try {
  $piList = & pi list 2>&1
  $piListStr = $piList -join "`n"
  foreach ($p in @("pi-subagents","pi-web-access","pi-mcp-adapter","pi-goal","pi-accounts","pi-usage","rpiv-ask-user-question","pi-fff","pi-background-tasks")) {
    Status "package: $p" $(if ($piListStr -match $p) { "PASS" } else { "FAIL" }) ""
  }
} catch { foreach ($p in @("pi-subagents","pi-web-access","pi-mcp-adapter","pi-goal","pi-accounts","pi-usage","rpiv-ask-user-question","pi-fff","pi-background-tasks")) { Status "package: $p" "NOT CHECKED" "" } }

$askUserConfig = [string](& node $Lib "resolve-config-path" ([string]$Stack.configPaths.askUserQuestion) ([string]$Stack.askUserQuestion.configRelativePath) 2>&1 | Select-Object -Last 1)
$askUserConfig = $askUserConfig.Trim()
$askGuidance = $Stack.askUserQuestion.guidance | ConvertTo-Json -Depth 10 -Compress
$askGuidanceFile = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($askGuidanceFile, $askGuidance, [System.Text.UTF8Encoding]::new($false))
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & node $Lib "verify-owned-fields" $askUserConfig "guidance" "@$askGuidanceFile" 2>&1 | Out-Null; $askGuidanceExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
} finally { Remove-Item $askGuidanceFile -Force -ErrorAction SilentlyContinue }
Status "ask-user-question guidance" $(if ($askGuidanceExit -eq 0) { "PASS" } else { "FAIL" }) $(if ($askGuidanceExit -eq 0) { $askUserConfig } else { "missing or mismatched: $askUserConfig" })

# pi-fff feature state
$piFffFeatures = Expand-Path $Stack.configPaths.piFffFeatures
if (Test-Path $piFffFeatures) {
  $fff = Get-Content $piFffFeatures -Raw | ConvertFrom-Json
  $allPresent = ($Stack.fff.enabledFeatures | Where-Object { $fff.enabledFeatures -notcontains $_ }).Count -eq 0
  $retiredPresent = ($Stack.fff.retiredFeatures | Where-Object { $fff.enabledFeatures -contains $_ }).Count -gt 0
  $allPresent = $allPresent -and -not $retiredPresent
  Status "fff feature state" $(if ($allPresent) { "PASS" } else { "WARN" }) $(if ($allPresent) { "startup notices and custom agent tools disabled" } else { "incomplete" })
} else { Status "fff feature state" "WARN" "missing" }

# pi-goal unlimited-turn configuration + status patch
$piGoalSettings = Expand-Path $Stack.configPaths.piGoal
if (Test-Path $piGoalSettings) {
  $goal = Get-Content $piGoalSettings -Raw | ConvertFrom-Json
  $unlimited = $goal.continuationLimits.automaticTurns -eq $null
  Status "pi-goal unlimited turns" $(if ($unlimited) { "PASS" } else { "WARN" }) $(if ($unlimited) { "automaticTurns=null" } else { "automaticTurns not null" })
} else { Status "pi-goal unlimited turns" "WARN" "pi-goal.json missing" }
$goalPatchScript = Join-Path $ScriptDir "lib\pui-goal-patch.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $goalPatchScript verify 2>&1 | Out-Null; $goalPatchExit = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
Status "pi-goal status patch" $(if ($goalPatchExit -eq 0) { "PASS" } else { "WARN" }) $(if ($goalPatchExit -eq 0) { "formatStatus null branch hidden" } else { "patch not applied (version drift)" })

# default tool set
if (Test-Path $piSettings) {
  $st = Get-Content $piSettings -Raw | ConvertFrom-Json
  $dt = $st.defaultTools
  $missing = $Stack.defaultTools | Where-Object { $dt -notcontains $_ }
  Status "default tool set" $(if ($missing.Count -eq 0) { "PASS" } else { "WARN" }) "missing: $($missing -join ', ')"
  foreach ($spec in @($Stack.piPackages)) { Status "managed pin: $spec" $(if (@($st.packages) -contains $spec) { "PASS" } else { "FAIL" }) "" }
} else { Status "default tool set" "WARN" "settings.json missing" }

# web routing
if (Test-Path $piWebAccess) {
  $wa = Get-Content $piWebAccess -Raw | ConvertFrom-Json
  $ddg = $wa.searchRouting.providers -contains "duckduckgo"
  $httpOnly = $wa.fetchRouting.allowRemoteHostedProviders -eq $false
  Status "web routing" $(if ($ddg -and $httpOnly) { "PASS" } else { "WARN" }) "duckduckgo=$ddg httpOnly=$httpOnly"
} else { Status "web routing" "WARN" "web-search.json missing" }

# MCP adapter + Playwright
if (Test-Path $mcpShared) {
  $mcp = Get-Content $mcpShared -Raw | ConvertFrom-Json
  $expectedMcp = ConvertTo-Json -Compress -InputObject @($Stack.mcp.args)
  $actualMcp = ConvertTo-Json -Compress -InputObject @($mcp.mcpServers.playwright.args)
  $expectedDirectTools = ConvertTo-Json -Compress -InputObject @($Stack.mcp.directTools)
  $actualDirectTools = ConvertTo-Json -Compress -InputObject @($mcp.mcpServers.playwright.directTools)
  $proxyEnabled = -not ($mcp.settings -and $mcp.settings.disableProxyTool -eq $true)
  Status "Playwright MCP" $(if ($mcp.mcpServers.playwright -and $expectedMcp -eq $actualMcp -and $expectedDirectTools -eq $actualDirectTools -and $proxyEnabled) { "PASS" } else { "FAIL" }) $(if ($proxyEnabled) { "exact version; 6 direct tools; proxy preserved" } else { "settings.disableProxyTool=true" })
  $footerMatches = $mcp.settings.mcpFooterStatus -eq [string]$Stack.mcp.footerStatus
  Status "MCP footer status" $(if ($footerMatches) { "PASS" } else { "FAIL" }) $(if ($footerMatches) { "matches stack.json" } else { "missing or does not match stack.json (expected $($Stack.mcp.footerStatus))" })
} else {
  Status "Playwright MCP" "WARN" "mcp.json missing"
  Status "MCP footer status" "FAIL" "mcp.json missing (expected $($Stack.mcp.footerStatus))"
}

# pi-background-tasks compact model guidance and native node-pty binding
$backgroundPatch = Join-Path $ScriptDir "lib\pui-background-tasks-patch.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $backgroundPatch verify 2>&1 | Out-Null; $backgroundPatchExit = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
Status "pi-background-tasks prompt" $(if ($backgroundPatchExit -eq 0) { "PASS" } else { "FAIL" }) $(if ($backgroundPatchExit -eq 0) { "compact PUI guidance" } else { "missing or drifted" })
$nativeCheck = Join-Path $ScriptDir "lib\pui-native-check.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $nativeCheck verify (Join-Path $piAgentDir "npm") 2>&1 | Out-Null; $nativeExit = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
Status "pi-background-tasks native" $(if ($nativeExit -eq 0) { "PASS" } else { "FAIL" }) $(if ($nativeExit -eq 0) { "node-pty loads" } else { "node-pty binding missing" })
# pi-subagents taxonomy, capabilities, mapped model, and reasoning policy
$puiSubagentsConfig = Expand-Path $Stack.configPaths.puiSubagents
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $Lib "validate-model-mappings" $puiSubagentsConfig 2>&1 | Out-Null; $subagentConfigExit = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
Status "subagent model mappings" $(if ($subagentConfigExit -eq 0) { "PASS" } else { "FAIL" }) $(if ($subagentConfigExit -eq 0) { $puiSubagentsConfig } else { "missing or invalid: $puiSubagentsConfig" })
$subagentsPatch = Join-Path $ScriptDir "lib\pui-subagents-patch.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $subagentsPatch verify 2>&1 | Out-Null; $subagentsPatchExit = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
Status "subagent policy" $(if ($subagentsPatchExit -eq 0) { "PASS" } else { "FAIL" }) $(if ($subagentsPatchExit -eq 0) { "taxonomy, capabilities, model, and reasoning" } else { "missing or drifted" })

# Pi Web health. A registered PUI autostart with no healthy server is a broken
# managed runtime, not an optional/manual-start warning.
$launcherVbs = Join-Path ([Environment]::GetFolderPath("Startup")) "pui-piweb.vbs"
try {
  $r = Invoke-WebRequest $piWebUrl -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
  if ([int]$r.StatusCode -eq 200) { Status "Pi Web health" "PASS" "HTTP $($r.StatusCode)" }
  elseif (Test-Path $launcherVbs) { Status "Pi Web health" "FAIL" "managed autostart returned HTTP $($r.StatusCode) on $piWebUrl" }
  else { Status "Pi Web health" "WARN" "HTTP $($r.StatusCode) on $piWebUrl" }
} catch {
  if (Test-Path $launcherVbs) { Status "Pi Web health" "FAIL" "managed autostart is not running on $piWebUrl" }
  else { Status "Pi Web health" "WARN" "not running on $piWebUrl" }
}

& node (Join-Path $ScriptDir "lib\pui-update-extension.js") verify $ScriptDir 2>$null | Out-Null
Status "PUI installed identity" $(if ($LASTEXITCODE -eq 0) { "PASS" } else { "FAIL" }) "extension manifest"
if (Test-Command npm) {
  & node (Join-Path $ScriptDir "lib\pui-web-integration.js") verify $ScriptDir $piWebRoot 2>$null | Out-Null
  Status "PUI update bridge" $(if ($LASTEXITCODE -eq 0) { "PASS" } else { "FAIL" }) "Pi Web $($Stack.upstream.gui.version)"
}

# autostart registration
$piWebCmd = "$env:APPDATA\npm\pi-web.cmd"
$expectedVbs = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c set PI_WEB_SKIP_VERSION_CHECK=1&&""$piWebCmd"" --no-open", 0, False
"@
if (-not (Test-Path $launcherVbs)) { Status "autostart registration" "WARN" "no pui-piweb.vbs" }
elseif (-not (Test-Path $piWebCmd)) { Status "autostart registration" "FAIL" "Pi Web launcher is missing: $piWebCmd" }
elseif ([System.IO.File]::ReadAllText($launcherVbs) -ne $expectedVbs) { Status "autostart registration" "FAIL" "pui-piweb.vbs is modified" }
else { Status "autostart registration" "PASS" "canonical hidden launcher" }

# PWA status
Status "PWA status" "USER ACTION REQUIRED" "verify browser install manually"

if ($script:Fails -gt 0) { exit 1 }
} finally { Wait-IfInteractive }
