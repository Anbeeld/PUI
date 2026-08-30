#requires -Version 5.1
<#
.SYNOPSIS
  PUI uninstaller for native Windows. Removes only PUI-added integration by default.
  Preserves user projects, sessions, model auth, AGENTS.md, skills, prompts, themes,
  and unrelated Pi configuration. Leaves Pi and Pi Web installed unless -Full is given.
.PARAMETER Full
  Also uninstall Pi packages, pi-web, and pi itself after removing PUI integration.
#>
[CmdletBinding()]
param([switch]$Full)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Stack = Get-Content (Join-Path $ScriptDir "stack.json") -Raw | ConvertFrom-Json
$Lib = Join-Path $ScriptDir "lib\pui-config.js"

function Wait-IfInteractive {
  if ($env:PUI_NONINTERACTIVE) { return }
  try { Write-Host ""; Read-Host -Prompt "Press Enter to close this window" | Out-Null } catch {}
}

try {

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

function Expand-Path($p) { if ($p -match '^~') { return (Join-Path $env:USERPROFILE ($p -replace '^~[\\/]?','')) }; return $p }

Write-Host "=== PUI uninstall (Windows) ===" -ForegroundColor Cyan

# 1. remove Pi Web autostart created by PUI (Startup folder launcher). Compare
# complete canonical content so drifted/user-modified files are preserved.
$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherVbs = Join-Path $startupFolder "pui-piweb.vbs"
$launcherBat = Join-Path $startupFolder "pui-piweb.bat"
$piWebCmd = "$env:APPDATA\npm\pi-web.cmd"
$vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c set PI_WEB_SKIP_VERSION_CHECK=1&&""$piWebCmd"" --no-open", 0, False
"@
$batContent = "@echo off`r`nset PI_WEB_SKIP_VERSION_CHECK=1`r`n`"%APPDATA%\npm\pi-web.cmd`" --no-open`r`n"
if (Test-Path $launcherVbs) {
  if (([System.IO.File]::ReadAllText($launcherVbs) -ceq $vbsContent)) {
    Write-Host "  removing canonical autostart launcher: $launcherVbs"
    Remove-Item $launcherVbs -Force
  } else {
    Write-Host "  autostart launcher differs from the complete canonical shape; preserving (user-owned): $launcherVbs" -ForegroundColor Yellow
  }
}
if (Test-Path $launcherBat) {
  if (([System.IO.File]::ReadAllText($launcherBat) -ceq $batContent)) {
    Write-Host "  removing canonical legacy autostart launcher: $launcherBat"
    Remove-Item $launcherBat -Force
  } else {
    Write-Host "  legacy autostart launcher differs from the complete canonical shape; preserving (user-owned): $launcherBat" -ForegroundColor Yellow
  }
}
if (-not (Test-Path $launcherVbs) -and -not (Test-Path $launcherBat)) { Write-Host "  no canonical autostart launcher found" }

# Stop only processes launched from the globally installed Pi Web package. This
# releases Windows' file locks before a full npm uninstall and matches the
# LaunchAgent/systemd stop performed by the Unix uninstaller.
$piWebProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match '[\\/]node_modules[\\/]@agegr[\\/]pi-web[\\/]' -or
  $_.CommandLine -match '[\\/]npm[\\/]pi-web\.cmd(?:"|\s)'
}
foreach ($process in $piWebProcesses) {
  Write-Host "  stopping Pi Web process $($process.ProcessId)"
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($piWebProcesses) { Start-Sleep -Milliseconds 500 }

# 2. PWA browser app — cannot be removed safely/specifically by a CLI script.
Write-Host "  PWA browser app: remove manually from the browser's app/shortcut settings if installed." -ForegroundColor Yellow

# 3. remove PUI-created Playwright MCP entry (only if it still matches PUI-managed shape)
$mcpShared = Expand-Path $Stack.configPaths.mcpShared
if (Test-Path $mcpShared) {
  $mcp = Get-Content $mcpShared -Raw | ConvertFrom-Json
  $pw = $mcp.mcpServers.playwright
  if ($pw) {
    # structural ownership check: exact command, args, lifecycle, and direct tools against
    # the PUI-managed definition; anything else is user-owned and preserved.
    $puiArgs = ConvertTo-Json -InputObject @($Stack.mcp.args) -Compress
    $exArgs = "null"
    if ($pw.args) { $exArgs = ConvertTo-Json -InputObject @($pw.args) -Compress }
    $puiDirectTools = ConvertTo-Json -InputObject @($Stack.mcp.directTools) -Compress
    $exDirectTools = ConvertTo-Json -InputObject @($pw.directTools) -Compress
    $pkgMatch = ($pw.command -eq [string]$Stack.mcp.command) -and ($exArgs -eq $puiArgs) -and ($pw.lifecycle -eq [string]$Stack.mcp.lifecycle) -and ($exDirectTools -eq $puiDirectTools)
    if ($pkgMatch) {
      Write-Host "  removing PUI-managed 'playwright' MCP entry from $mcpShared"
      & node $Lib "backup" $mcpShared | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Host "  MCP config backup failed; uninstall aborted" -ForegroundColor Red; exit 1 }
      & node $Lib "remove-server" $mcpShared "playwright" | Out-Null
    } else {
      Write-Host "  'playwright' MCP entry differs from PUI-managed shape; preserving (user-owned)." -ForegroundColor Yellow
    }
  }
}

$askUserConfigs = @(& node $Lib "config-candidate-paths" ([string]$Stack.configPaths.askUserQuestion) ([string]$Stack.askUserQuestion.configRelativePath) 2>&1)
$askGuidance = $Stack.askUserQuestion.guidance | ConvertTo-Json -Depth 10 -Compress
$askGuidanceFile = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($askGuidanceFile, $askGuidance, [System.Text.UTF8Encoding]::new($false))
  foreach ($askUserConfig in @($askUserConfigs | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path $askUserConfig)) { continue }
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & node $Lib "remove-owned-fields" $askUserConfig "guidance" "@$askGuidanceFile" 2>&1 | Out-Null; $askRemoveExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
    if ($askRemoveExit -eq 0) {
      Write-Host "  backed up and removed PUI-managed ask-user-question guidance from $askUserConfig"
    } elseif ($askRemoveExit -eq 2) {
      Write-Host "  ask-user-question guidance differs from the PUI-managed shape; preserving (user-owned)." -ForegroundColor Yellow
    } else {
      Write-Host "  could not inspect ask-user-question guidance; preserving $askUserConfig." -ForegroundColor Yellow
    }
  }
} finally { Remove-Item $askGuidanceFile -Force -ErrorAction SilentlyContinue }

# 3b. Restore original pi-web files (undo PUI branding/icon overrides).
try {
  $globalRoot = & npm root -g
  $piWebRoot = Join-Path (Join-Path $globalRoot "@agegr") "pi-web"
  $standalonePiRoot = Join-Path $globalRoot "@earendil-works\pi-coding-agent"
  $reasoningPatchScript = Join-Path $ScriptDir "lib\pui-reasoning-summary-patch.js"
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & node $reasoningPatchScript remove $piWebRoot $standalonePiRoot $ScriptDir 2>&1 | Out-Null; $reasoningRemoveExit = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
  if ($reasoningRemoveExit -ne 0) { Write-Host "  reasoning-summary patch differs from its owned shape; preserving." -ForegroundColor Yellow }
  if (Test-Path $piWebRoot) {
    $backportScript = Join-Path $ScriptDir "lib\pui-pi-8782-backport.js"
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & node $backportScript remove $piWebRoot 2>&1 | Out-Null; $backportRemoveExit = $LASTEXITCODE }
    finally { $ErrorActionPreference = $prev }
    if ($backportRemoveExit -ne 0) { Write-Host "  Pi #8782 backport differs from its owned shape; preserving." -ForegroundColor Yellow }
    & node (Join-Path $ScriptDir "lib\pui-web-integration.js") remove $ScriptDir $piWebRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "  PUI update integration differs from its owned shape; preserving." -ForegroundColor Yellow }
    Get-ChildItem $piWebRoot -Recurse -Filter "*.pui-created" -File -ErrorAction SilentlyContinue | ForEach-Object {
      $created = $_.FullName -replace '\.pui-created$', ''
      if (Test-Path $created) { Remove-Item $created -Force }
      Remove-Item $_.FullName -Force
      Write-Host "  removed PUI-created asset: $([IO.Path]::GetFileName($created))"
    }
    Get-ChildItem $piWebRoot -Recurse -Filter "*.pui-original" -File -ErrorAction SilentlyContinue | ForEach-Object {
      $orig = $_.FullName -replace '\.pui-original$', ''
      Copy-Item $_.FullName $orig -Force
      Remove-Item $_.FullName -Force
      Write-Host "  restored original: $($_.Name -replace '\.pui-original$', '')"
    }
  }
} catch { Write-Host "  icon/branding restore skipped: $_" -ForegroundColor Yellow }

$backgroundPatch = Join-Path $ScriptDir "lib\pui-background-tasks-patch.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $backgroundPatch remove 2>&1 | Out-Null; $backgroundRemoveExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($backgroundRemoveExit -eq 0) { Write-Host "  removed the PUI-owned pi-background-tasks prompt override when present" }
else { Write-Host "  pi-background-tasks prompt override differs from its PUI-owned shape; preserving." -ForegroundColor Yellow }
$subagentsPatch = Join-Path $ScriptDir "lib\pui-subagents-patch.js"
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try { & node $subagentsPatch remove 2>&1 | Out-Null; $subagentsRemoveExit = $LASTEXITCODE }
finally { $ErrorActionPreference = $prev }
if ($subagentsRemoveExit -eq 0) { Write-Host "  removed the PUI-owned pi-subagents policy patch when present" }
else { Write-Host "  pi-subagents policy patch differs from its PUI-owned shape; preserving." -ForegroundColor Yellow }

& node (Join-Path $ScriptDir "lib\pui-update-extension.js") remove $ScriptDir | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "  PUI update extension differs from its owned shape; preserving." -ForegroundColor Yellow }

# 4. optionally remove PUI-selected Pi packages
if ($Full) {
  Write-Host "  -Full: removing PUI-selected Pi packages..."
  $managedPackages = @($Stack.piPackages) + @($Stack.retiredPiPackages) | Select-Object -Unique
  foreach ($spec in $managedPackages) {
    $removeSpec = $spec -replace '@\d+\.\d+\.\d+$',''
    Write-Host "    pi remove $removeSpec"
    try { & pi remove $removeSpec 2>&1 | ForEach-Object { Write-Host "      $_" } } catch { Write-Host "      remove failed: $_" -ForegroundColor Yellow }
  }
  Write-Host "  -Full: uninstalling pi-web and pi (npm globals)..."
  & npm uninstall -g "@agegr/pi-web" 2>&1 | Out-Null
  & npm uninstall -g "@earendil-works/pi-coding-agent" 2>&1 | Out-Null
} else {
  Write-Host "  Pi packages, pi-web, and pi are left installed (use -Full to remove them too)." -ForegroundColor DarkGray
}

# 5. leave user data intact: sessions, model auth, AGENTS.md, skills, prompts, themes.
Write-Host "  Preserved: ~/.pi/agent (sessions, settings, auth, skills, prompts, themes)." -ForegroundColor Green
Write-Host "  Preserved: unrelated MCP servers and pi-web-access settings." -ForegroundColor Green
Write-Host "  Preserved: pi and pi-web (unless -Full)." -ForegroundColor Green

Write-Host "`nPUI uninstall complete." -ForegroundColor Green
} finally { Wait-IfInteractive }
