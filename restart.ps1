# Restart only the installed Pi Web runtime; no package or configuration changes.
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$Stack = Get-Content -Raw (Join-Path $PSScriptRoot "stack.json") | ConvertFrom-Json
$piWebCmd = "$env:APPDATA\npm\pi-web.cmd"
if (-not (Test-Path $piWebCmd)) { throw "Pi Web launcher not found: $piWebCmd" }

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
function Start-PiWebHidden {
  # Use the same hidden npm shim launch as install and update.
  $piWebCmd = "$env:APPDATA\npm\pi-web.cmd"
  if (-not (Test-Path $piWebCmd)) { return $false }
  $previousSkipVersionCheck = $env:PI_WEB_SKIP_VERSION_CHECK
  $previousPreference = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    $env:PI_WEB_SKIP_VERSION_CHECK = "1"
    $launchArgs = '/d /s /c ""{0}" --no-open"' -f $piWebCmd
    Start-Process -FilePath $env:ComSpec -ArgumentList $launchArgs -WindowStyle Hidden -ErrorAction Stop | Out-Null
  } catch {
    Write-Host "  could not launch pi-web: $($_.Exception.Message)" -ForegroundColor Red
    return $false
  } finally {
    $ErrorActionPreference = $previousPreference
    if ($null -eq $previousSkipVersionCheck) { Remove-Item Env:PI_WEB_SKIP_VERSION_CHECK -ErrorAction SilentlyContinue }
    else { $env:PI_WEB_SKIP_VERSION_CHECK = $previousSkipVersionCheck }
  }
  return $true
}

Write-Host "Restarting PUI (active sessions will be interrupted)..."
foreach ($pidToStop in @(Get-PiWebPid)) {
  Write-Host "  stopping Pi Web (PID $pidToStop)"
  Stop-Process -Id $pidToStop -Force -ErrorAction Stop
}
if (-not (Wait-PiWebStopped)) { throw "Could not stop Pi Web" }
if (-not (Start-PiWebHidden)) { throw "Could not launch Pi Web" }
if (-not (Wait-PiWebHealthy)) { throw "Pi Web did not become healthy after restart at $($Stack.piWeb.url)" }
Write-Host "PUI restarted and healthy at $($Stack.piWeb.url)"
