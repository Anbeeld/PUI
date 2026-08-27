#!/usr/bin/env bash
# PUI updater for native macOS and Linux. Preserves architecture; runs smoke suite after.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${1:-}" != "--apply-staged" ] && [ "${PUI_APPLY_STAGED:-}" != "1" ]; then
  exec node "$SCRIPT_DIR/lib/pui-updater.js" manual "$SCRIPT_DIR"
fi
if [ "${1:-}" = "--apply-staged" ]; then shift; fi
LIB="$SCRIPT_DIR/lib/pui-config.js"
STACK="$SCRIPT_DIR/stack.json"
STACK_READER="$SCRIPT_DIR/lib/pui-stack.js"
expand_path() { echo "${1/#\~/$HOME}"; }
jget() { node "$STACK_READER" "$STACK" "$1"; }
pui_fail() { [ "${PUI_FAIL_AT:-}" = "$1" ] && { echo "Injected update failure at $1" >&2; exit 97; }; return 0; }

# ---- OS detection ----
OS_TYPE="$(uname -s)"
case "$OS_TYPE" in
  Darwin) OS_NAME="macOS" ;;
  Linux)  OS_NAME="Linux" ;;
  *) echo "Unsupported OS: $OS_TYPE"; exit 1 ;;
esac

PLIST_LABEL="com.pui.piweb"
PLIST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
SERVICE_NAME="pui-piweb"

piweb_autostart_running() {
  if [ "$OS_NAME" = "macOS" ]; then
    launchctl print "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null | grep -q "state = running"
  else
    systemctl --user is-active --quiet "$SERVICE_NAME"
  fi
}

echo "=== PUI update ($OS_NAME) ==="

BACKUP_FILES=()

PI_WEB_ACCESS="$(expand_path "$(jget configPaths.piWebAccess)")"
PI_AGENT_DIR="$(expand_path "$(jget configPaths.piAgentDir)")"
MCP_SHARED="$(expand_path "$(jget configPaths.mcpShared)")"
PI_SETTINGS="$(expand_path "$(jget configPaths.piSettings)")"
PIWEB_URL="$(jget piWeb.url)"

for f in "$PI_WEB_ACCESS" "$MCP_SHARED" "$PI_SETTINGS"; do
  if [ -f "$f" ]; then
    BK="$(node "$LIB" backup "$f" | tail -1)"
    echo "  backed up: $BK"
    BACKUP_FILES+=("$BK")
  fi
done

# Final fail-safe idle check must happen while the server can still report its
# active sessions. If a running Pi Web cannot report activity, fail closed.
if pgrep -f '[/]node_modules[/]@agegr[/]pi-web[/]' >/dev/null 2>&1; then
  RUNNING_JSON="$(curl -sf --max-time 3 "$PIWEB_URL/api/agent/running" 2>/dev/null)" || { echo "  could not verify Pi Web idle state; update aborted" >&2; exit 1; }
  set +e
  node -e 'const s=JSON.parse(process.argv[1]);if(!Array.isArray(s.runningSessionIds))process.exit(2);process.exit(s.runningSessionIds.length?75:0)' "$RUNNING_JSON"
  RUNNING_EXIT=$?
  set -e
  if [ "$RUNNING_EXIT" -eq 75 ]; then echo "  active Pi Web sessions appeared; update deferred without stopping them" >&2; exit 75; fi
  if [ "$RUNNING_EXIT" -ne 0 ]; then echo "  Pi Web returned an invalid activity response; update aborted" >&2; exit 1; fi
fi

# Stop the configured service manager before killing any leftover process so
# restart-on-failure cannot race the global package update.
AUTOSTART_CONFIGURED=0
if [ "$OS_NAME" = "macOS" ] && [ -f "$PLIST" ]; then
  AUTOSTART_CONFIGURED=1
  if launchctl print "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1; then
    launchctl unload "$PLIST" 2>/dev/null || { echo "  failed to stop LaunchAgent $PLIST_LABEL" >&2; exit 1; }
  fi
elif [ "$OS_NAME" = "Linux" ] && systemctl --user is-enabled "$SERVICE_NAME" >/dev/null 2>&1; then
  AUTOSTART_CONFIGURED=1
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || { echo "  failed to stop $SERVICE_NAME" >&2; exit 1; }
fi

pkill -f '[/]node_modules[/]@agegr[/]pi-web[/]' 2>/dev/null || true
# Wait until the pi-web process is actually gone before npm install (parity with Windows).
for _ in $(seq 1 15); do
  pgrep -f '[/]node_modules[/]@agegr[/]pi-web[/]' >/dev/null 2>&1 || break
  sleep 1
done
# Fail fast if pi-web is still running: proceeding would make npm hit EBUSY (parity with Windows).
if pgrep -f '[/]node_modules[/]@agegr[/]pi-web[/]' >/dev/null 2>&1; then
  echo "  could not stop Pi Web (PID $(pgrep -f '[/]node_modules[/]@agegr[/]pi-web[/]' | tr '\n' ' ')); close Pi Web and rerun the update; update aborted" >&2
  exit 1
fi
set +e
node "$SCRIPT_DIR/lib/pui-updater.js" standalone-busy
STANDALONE_EXIT=$?
set -e
if [ "$STANDALONE_EXIT" -eq 75 ]; then echo "  standalone Pi became active; update deferred" >&2; exit 75; fi
if [ "$STANDALONE_EXIT" -ne 0 ]; then echo "  could not verify standalone Pi idle state" >&2; exit 1; fi

echo "  updating @agegr/pi-web..."
PIWEB_SPEC="$(jget upstream.gui.npm)@$(jget upstream.gui.version)"
NPM_EXIT=1
ATTEMPT=0
while [ "$NPM_EXIT" -ne 0 ] && [ "$ATTEMPT" -lt 5 ]; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -gt 1 ]; then echo "  retrying pi-web install (attempt $ATTEMPT)..."; sleep 2; fi
  NPM_EXIT=0
  npm install -g --ignore-scripts "$PIWEB_SPEC" >/dev/null 2>&1 || NPM_EXIT=$?
done
if [ "$NPM_EXIT" -ne 0 ]; then echo "  pi-web update failed" >&2; exit 1; fi

GLOBAL_ROOT="$(npm root -g)"
PIWEB_CA_VER="$(jget upstream.agentRuntime.version)"
if [ -n "$PIWEB_CA_VER" ]; then
  echo "  pi-web uses pi-coding-agent $PIWEB_CA_VER"
else
  echo "  could not resolve pi-web coding-agent version; standalone pi left unchanged"
fi

# Install standalone pi at matching version (only when misaligned).
PI_CUR=""
if command -v pi >/dev/null 2>&1; then
  PI_CUR="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
fi
if [ -n "$PIWEB_CA_VER" ] && [ "$PI_CUR" != "$PIWEB_CA_VER" ]; then
  echo "  aligning standalone pi to $PIWEB_CA_VER..."
  npm install -g --ignore-scripts "$(jget upstream.agentRuntime.npm)@$PIWEB_CA_VER" >/dev/null 2>&1 || { echo "  pi update failed" >&2; exit 1; }
elif [ -z "$PIWEB_CA_VER" ]; then
  :
else
  echo "  standalone pi already at $PIWEB_CA_VER"
fi

# Re-apply PUI icon override (npm update overwrites the package files).
PUI_ICONS_DIR="$SCRIPT_DIR/assets/icons"
if [ -d "$PUI_ICONS_DIR" ]; then
  PIWEB_PKG_ROOT="$(npm root -g 2>/dev/null)/@agegr/pi-web" || true
  PIWEB_ICONS_DIR="$PIWEB_PKG_ROOT/public/icons"
  if [ -d "$PIWEB_ICONS_DIR" ]; then
    echo "  re-applying complete PUI icon set..."
    if ! node "$SCRIPT_DIR/lib/pui-icons.js" apply "$PUI_ICONS_DIR" "$PIWEB_PKG_ROOT"; then
      echo "  PUI icon override failed" >&2
      exit 1
    fi
    # Apply only top-level text branding. The shared helper handles each
    # Next.js serialization shape and leaves Pi Web component references intact.
    if ! node "$SCRIPT_DIR/lib/pui-branding.js" apply "$PIWEB_PKG_ROOT"; then
      echo "  PUI text branding override failed" >&2
      exit 1
    fi
    node "$SCRIPT_DIR/lib/pui-web-integration.js" apply "$SCRIPT_DIR" "$PIWEB_PKG_ROOT" || { echo "  Pi Web update integration failed" >&2; exit 1; }
    pui_fail pi-web-integration
  else
    echo "  Pi Web icon directory missing: $PIWEB_ICONS_DIR" >&2
    exit 1
  fi
else
  echo "  PUI icon directory missing: $PUI_ICONS_DIR" >&2
  exit 1
fi

# Reconcile packages PUI added or retired before updating existing extensions.
package_installed() {
  node -e 'const fs=require("fs");const f=process.argv[1],spec=process.argv[2];if(!fs.existsSync(f))process.exit(1);const s=JSON.parse(fs.readFileSync(f,"utf8"));const p=Array.isArray(s.packages)?s.packages:[];process.exit(p.some(x=>typeof x==="string"&&(x===spec||x.startsWith(spec+"@")))?0:1)' "$PI_SETTINGS" "$1"
}
for spec in $(node -e 'const s=require(process.argv[1]);for(const p of s.retiredPiPackages||[])console.log(p)' "$STACK"); do
  if package_installed "$spec"; then
    echo "  retiring $spec..."
    pi remove "$spec" 2>&1 | sed 's/^/    /' || { echo "  failed to retire $spec" >&2; exit 1; }
  fi
done
for spec in $(node -e 'const s=require(process.argv[1]);for(const p of s.piPackages)console.log(p)' "$STACK"); do
  echo "  reconciling managed extension $spec..."
  pi install "$spec" 2>&1 | sed 's/^/    /' || { echo "  failed to install $spec" >&2; exit 1; }
  node "$SCRIPT_DIR/lib/pui-config.js" set-package "$PI_SETTINGS" "$spec" >/dev/null || { echo "  failed to set exact managed pin for $spec" >&2; exit 1; }
done
pui_fail package-reconciliation

# Reconcile pi-fff feature state: suppress startup notices.
PI_FFF_FEATURES="$(expand_path "$(jget configPaths.piFffFeatures)")"
FFF_CFG="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify({enabledFeatures:s.fff.enabledFeatures}))' "$STACK")"
node "$LIB" merge-object "$PI_FFF_FEATURES" "$FFF_CFG" >/dev/null
echo "  pi-fff feature state reconciled (startup notices disabled)"

# Reconcile pi-goal settings: unlimited automatic turns with a readable status line.
PI_GOAL="$(expand_path "$(jget configPaths.piGoal)")"
GOAL_CFG='{"continuationLimits":{"automaticTurns":null,"noProgressTurns":3}}'
node "$LIB" merge-object "$PI_GOAL" "$GOAL_CFG" >/dev/null || { echo "  pi-goal settings reconciliation failed" >&2; exit 1; }
if ! node "$SCRIPT_DIR/lib/pui-goal-patch.js" apply >/dev/null 2>&1; then
  echo "  pi-goal status patch could not be applied (version drift); the turn counter may still show 'automatic Unlimited'." >&2
else
  echo "  pi-goal configured for unlimited turns with a readable status line"
fi

# Verify the node-pty native binding for @99percentpeople/pi-background-tasks.
if ! node "$SCRIPT_DIR/lib/pui-native-check.js" ensure "$PI_AGENT_DIR/npm" >/dev/null 2>&1; then
  echo "  pi-background-tasks native (node-pty) binding could not be verified or rebuilt; update aborted. Install the required compiler toolchain and rerun update.sh." >&2
  exit 1
fi

echo "  reconciling managed Playwright MCP..."
MCP_DEF="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify({command:s.mcp.command,args:s.mcp.args,lifecycle:s.mcp.lifecycle,directTools:s.mcp.directTools}))' "$STACK")"
set +e
node "$LIB" set-server "$MCP_SHARED" "$(jget mcp.serverName)" "$MCP_DEF" >/dev/null
MCP_EXIT=$?
set -e
if [ "$MCP_EXIT" -eq 2 ]; then
  echo "  existing Playwright MCP has a materially different configuration; update aborted" >&2
  exit 1
fi
if [ "$MCP_EXIT" -ne 0 ]; then
  echo "  failed to reconcile Playwright MCP" >&2
  exit 1
fi
# Reconcile MCP footer status: keep the extension status bar quiet.
node "$LIB" merge-object "$MCP_SHARED" '{"settings":{"mcpFooterStatus":"off"}}' >/dev/null || { echo "  MCP footer status reconciliation failed" >&2; exit 1; }
echo "  MCP footer status hidden (mcpFooterStatus=off)"
pui_fail config-migration
node "$SCRIPT_DIR/lib/pui-update-extension.js" install "$SCRIPT_DIR" >/dev/null || { echo "  PUI update extension replacement failed" >&2; exit 1; }
pui_fail extension-replacement
echo "  refreshing model catalogs..."
pi update --models 2>&1 | sed 's/^/    /' || { echo "  model catalog refresh failed" >&2; exit 1; }

# Restart Pi Web only through the configured service manager. Refresh the
# definition so both managers inherit the active Node/Pi Web bin directory.
PIWEB_BIN="$(command -v pi-web 2>/dev/null || true)"
if [ "$AUTOSTART_CONFIGURED" -eq 1 ] && [ -z "$PIWEB_BIN" ]; then
  echo "  pi-web not found after update" >&2
  exit 1
fi

if [ "$AUTOSTART_CONFIGURED" -eq 1 ]; then
  PIWEB_PATH="$(dirname "$PIWEB_BIN"):${PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
  if [ "$OS_NAME" = "macOS" ]; then
    echo "  restarting LaunchAgent $PLIST_LABEL..."
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PIWEB_BIN</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PI_WEB_SKIP_VERSION_CHECK</key><string>1</string>
    <key>PATH</key><string>$PIWEB_PATH</string>
  </dict>
</dict>
</plist>
EOF
    launchctl load "$PLIST" 2>/dev/null || { echo "  failed to load LaunchAgent $PLIST_LABEL" >&2; exit 1; }
  else
    SERVICE_DIR="$HOME/.config/systemd/user"
    SERVICE_FILE="$SERVICE_DIR/${SERVICE_NAME}.service"
    echo "  restarting systemd user service $SERVICE_NAME..."
    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=PUI Pi Web (loopback backend for PWA)
After=network-online.target

[Service]
Type=simple
Environment=PI_WEB_SKIP_VERSION_CHECK=1
Environment="PATH=$PIWEB_PATH"
ExecStart="$PIWEB_BIN" --no-open
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload 2>/dev/null || { echo "  failed to reload systemd user units" >&2; exit 1; }
    systemctl --user restart "$SERVICE_NAME" 2>/dev/null || { echo "  failed to restart $SERVICE_NAME" >&2; exit 1; }
  fi

  HEALTHY=0
  for ((i=0; i<30; i++)); do
    if piweb_autostart_running && curl -sf --max-time 5 "$PIWEB_URL" >/dev/null 2>&1; then
      HEALTHY=1
      break
    fi
    sleep 2
  done
  if [ "$HEALTHY" -ne 1 ]; then
    echo "  managed pi-web service did not reach running state with HTTP 200 within 60s" >&2
    if [ "$OS_NAME" = "macOS" ]; then
      launchctl print "gui/$(id -u)/$PLIST_LABEL" >&2 || true
    else
      systemctl --user status "$SERVICE_NAME" --no-pager >&2 || true
    fi
    exit 1
  fi
  echo "  managed pi-web service is running and healthy at $PIWEB_URL"
else
  echo "  no PUI autostart found; skipping pi-web restart"
fi

echo
echo "=== running smoke suite ==="
pui_fail restart-health
set +e
bash "$SCRIPT_DIR/doctor.sh"
DOCTOR_EXIT=$?
set -e

if [ "$DOCTOR_EXIT" -ne 0 ]; then
  echo
  echo "=== UPDATE FAILED VALIDATION ===" >&2
  echo "  Installed versions:" >&2
  command -v pi >/dev/null 2>&1 && echo "    pi: $(pi --version 2>/dev/null)" >&2
  echo "  Backups preserved (restore by copying over the live file):" >&2
  for b in "${BACKUP_FILES[@]}"; do echo "    $b" >&2; done
  echo "  The transaction worker will restore and validate the previous certified PUI release." >&2
  echo "  Update NOT declared successful." >&2
  exit 1
fi
pui_fail target-validation

echo
echo "Update complete: all doctor checks passed."
