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
  $pwCA = if (Test-Path $pwPkg) { (Get-Content $pwPkg -Raw | ConvertFrom-Json).dependencies.'@earendil-works/pi-coding-agent' } else { $null }
  Status "Pi Web-resolved Pi" "PASS" $pwCA
  $piVer = (& pi --version 2>$null) -replace '[^0-9.]',''
  $pwCAN = ($pwCA -replace '[^0-9.]','')
  Status "runtime parity" $(if ($piVer -eq [string]$Stack.upstream.agentRuntime.version -and $pwCAN -eq [string]$Stack.upstream.agentRuntime.version) { "PASS" } else { "FAIL" }) "pi=$piVer pi-web=$pwCAN expected=$($Stack.upstream.agentRuntime.version)"
} else { Status "Pi Web version" "FAIL" "pi-web not on PATH"; Status "Pi Web-resolved Pi" "NOT CHECKED" ""; Status "runtime parity" "NOT CHECKED" "" }

# Pi package presence
$piSettings = Expand-Path $Stack.configPaths.piSettings
$piWebAccess = Expand-Path $Stack.configPaths.piWebAccess
$mcpShared = Expand-Path $Stack.configPaths.mcpShared

try {
  $piList = & pi list 2>&1
  $piListStr = $piList -join "`n"
  foreach ($p in @("pi-subagents","pi-web-access","pi-mcp-adapter","pi-goal","rpiv-ask-user-question","pi-fff")) {
    Status "package: $p" $(if ($piListStr -match $p) { "PASS" } else { "FAIL" }) ""
  }
} catch { foreach ($p in @("pi-subagents","pi-web-access","pi-mcp-adapter","pi-goal","rpiv-ask-user-question","pi-fff")) { Status "package: $p" "NOT CHECKED" "" } }

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
} else { Status "Playwright MCP" "WARN" "mcp.json missing" }

# Pi Web health
try { $r = Invoke-WebRequest $piWebUrl -TimeoutSec 5 -UseBasicParsing; Status "Pi Web health" "PASS" "HTTP $($r.StatusCode)" }
catch { Status "Pi Web health" "WARN" "not running on $piWebUrl" }

& node (Join-Path $ScriptDir "lib\pui-update-extension.js") verify $ScriptDir 2>$null | Out-Null
Status "PUI installed identity" $(if ($LASTEXITCODE -eq 0) { "PASS" } else { "FAIL" }) "extension manifest"
if (Test-Command npm) {
  $piWebRoot = Join-Path (Join-Path (& npm root -g) "@agegr") "pi-web"
  & node (Join-Path $ScriptDir "lib\pui-web-integration.js") verify $ScriptDir $piWebRoot 2>$null | Out-Null
  Status "PUI update bridge" $(if ($LASTEXITCODE -eq 0) { "PASS" } else { "FAIL" }) "Pi Web $($Stack.upstream.gui.version)"
}

# autostart registration
$launcherVbs = Join-Path ([Environment]::GetFolderPath("Startup")) "pui-piweb.vbs"
Status "autostart registration" $(if (Test-Path $launcherVbs) { "PASS" } else { "WARN" }) $(if (Test-Path $launcherVbs) { "pui-piweb.vbs present" } else { "no pui-piweb.vbs" })

# PWA status
Status "PWA status" "USER ACTION REQUIRED" "verify browser install manually"

if ($script:Fails -gt 0) { exit 1 }
