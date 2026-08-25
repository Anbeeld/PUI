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

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

function Expand-Path($p) { if ($p -match '^~') { return (Join-Path $env:USERPROFILE ($p -replace '^~[\\/]?','')) }; return $p }

Write-Host "=== PUI uninstall (Windows) ===" -ForegroundColor Cyan

# 1. remove Pi Web autostart created by PUI (Startup folder launcher)
$startupFolder = [Environment]::GetFolderPath("Startup")
$launcherVbs = Join-Path $startupFolder "pui-piweb.vbs"
$launcherBat = Join-Path $startupFolder "pui-piweb.bat"
foreach ($lf in @($launcherVbs, $launcherBat)) {
  if (Test-Path $lf) {
    Write-Host "  removing autostart launcher: $lf"
    Remove-Item $lf -Force -ErrorAction SilentlyContinue
  }
}
Write-Host "  autostart launcher removed (if present)"

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
    # structural ownership check: exact command, args, and lifecycle against
    # the PUI-managed definition; anything else is user-owned and preserved.
    $puiArgs = ConvertTo-Json -InputObject @($Stack.mcp.args) -Compress
    $exArgs = "null"
    if ($pw.args) { $exArgs = ConvertTo-Json -InputObject @($pw.args) -Compress }
    $pkgMatch = ($pw.command -eq [string]$Stack.mcp.command) -and ($exArgs -eq $puiArgs) -and ($pw.lifecycle -eq [string]$Stack.mcp.lifecycle)
    if ($pkgMatch) {
      Write-Host "  removing PUI-managed 'playwright' MCP entry from $mcpShared"
      & node $Lib "remove-server" $mcpShared "playwright" | Out-Null
    } else {
      Write-Host "  'playwright' MCP entry differs from PUI-managed shape; preserving (user-owned)." -ForegroundColor Yellow
    }
  }
}

# 3b. Restore original pi-web files (undo PUI branding/icon overrides).
try {
  $piWebRoot = Join-Path (Join-Path (& npm root -g) "@agegr") "pi-web"
  if (Test-Path $piWebRoot) {
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

# 4. optionally remove PUI-selected Pi packages
if ($Full) {
  Write-Host "  -Full: removing PUI-selected Pi packages..."
  $managedPackages = @($Stack.piPackages) + @($Stack.retiredPiPackages) | Select-Object -Unique
  foreach ($spec in $managedPackages) {
    Write-Host "    pi remove $spec"
    try { & pi remove $spec 2>&1 | ForEach-Object { Write-Host "      $_" } } catch { Write-Host "      remove failed: $_" -ForegroundColor Yellow }
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
