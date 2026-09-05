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

# npm's bulk-advisory audit POST stalls indefinitely on pi's large package tree;
# every npm child (including the one inside `pi install`) inherits this setting.
export npm_config_audit=false

PI_TIMEOUT_SECONDS=120
# Run a network-facing `pi` command with a hard watchdog. `pi` spawns npm
# children that can stall indefinitely on the registry or on file locks; the
# watchdog kills the whole pi process group on timeout so no orphan survives.
run_pi_bounded() {
  local tmp pid watchdog code=0
  tmp="$(mktemp)"
  set -m
  pi "$@" >"$tmp" 2>&1 &
  pid=$!
  set +m
  (
    for _ in $(seq 1 "$PI_TIMEOUT_SECONDS"); do
      sleep 1
      kill -0 "$pid" 2>/dev/null || exit 0
    done
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 15
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  ) &
  watchdog=$!
  if wait "$pid"; then code=0; else code=$?; fi
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  sed 's/^/    /' "$tmp"
  rm -f -- "$tmp"
  if [ "$code" -eq 143 ] || [ "$code" -eq 137 ]; then
    echo "  pi $* timed out after ${PI_TIMEOUT_SECONDS}s" >&2
  fi
  return "$code"
}

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
MCP_FOOTER_STATUS="$(jget mcp.footerStatus)"
PI_SETTINGS="$(expand_path "$(jget configPaths.piSettings)")"
PI_FFF_FEATURES="$(expand_path "$(jget configPaths.piFffFeatures)")"
PI_GOAL="$(expand_path "$(jget configPaths.piGoal)")"
PUI_SUBAGENTS_CONFIG="$(expand_path "$(jget configPaths.puiSubagents)")"
PUI_REASONING_SUMMARIES="$(expand_path "$(jget configPaths.puiReasoningSummaries)")"
PUI_SESSION_TITLES="$(expand_path "$(jget configPaths.puiSessionTitles)")"
ASK_USER_CONFIG="$(node "$LIB" resolve-config-path "$(jget configPaths.askUserQuestion)" "$(jget askUserQuestion.configRelativePath)")" || { echo "  ask-user-question config path resolution failed" >&2; exit 1; }
PIWEB_URL="$(jget piWeb.url)"

# The installed transaction worker may predate this patch. Keep a target-script
# snapshot so an introducing update can still restore these non-JSON artifacts.
BACKGROUND_PATCH="$SCRIPT_DIR/lib/pui-background-tasks-patch.js"
BACKGROUND_SNAPSHOT="$(mktemp -d "${TMPDIR:-/tmp}/pui-background-task.XXXXXX")"
BACKGROUND_PATCH_COMMITTED=0
SUBAGENTS_PATCH="$SCRIPT_DIR/lib/pui-subagents-patch.js"
SUBAGENTS_SNAPSHOT="$(mktemp -d "${TMPDIR:-/tmp}/pui-subagents.XXXXXX")"
SUBAGENTS_PATCH_COMMITTED=0
GLOBAL_ROOT="$(npm root -g)"
REASONING_PATCH="$SCRIPT_DIR/lib/pui-reasoning-summary-patch.js"
REASONING_SNAPSHOT="$(mktemp -d "${TMPDIR:-/tmp}/pui-reasoning-summary.XXXXXX")"
REASONING_PATCH_COMMITTED=0
SKILL_LOADER_EXTENSION="$SCRIPT_DIR/lib/pui-skill-loader-extension.js"
SKILL_LOADER_SNAPSHOT="$(mktemp -d "${TMPDIR:-/tmp}/pui-skill-loader.XXXXXX")"
SKILL_LOADER_SNAPSHOT_COMMITTED=0
SESSION_TITLE_EXTENSION="$SCRIPT_DIR/lib/pui-session-title-extension.js"
SESSION_TITLE_SNAPSHOT="$(mktemp -d "${TMPDIR:-/tmp}/pui-session-title.XXXXXX")"
SESSION_TITLE_SNAPSHOT_COMMITTED=0
REASONING_PIWEB_ROOT="${GLOBAL_ROOT}/@agegr/pi-web"
REASONING_STANDALONE_ROOT="${GLOBAL_ROOT}/@earendil-works/pi-coding-agent"
if ! node "$SKILL_LOADER_EXTENSION" snapshot "$SKILL_LOADER_SNAPSHOT" "$SCRIPT_DIR" >/dev/null 2>&1; then
  rm -rf -- "$BACKGROUND_SNAPSHOT" "$SUBAGENTS_SNAPSHOT" "$REASONING_SNAPSHOT" "$SKILL_LOADER_SNAPSHOT" "$SESSION_TITLE_SNAPSHOT"
  echo "  could not snapshot PUI skill-loader extension; update aborted" >&2
  exit 1
fi
if ! node "$SESSION_TITLE_EXTENSION" snapshot "$SESSION_TITLE_SNAPSHOT" "$SCRIPT_DIR" >/dev/null 2>&1; then
  rm -rf -- "$BACKGROUND_SNAPSHOT" "$SUBAGENTS_SNAPSHOT" "$REASONING_SNAPSHOT" "$SKILL_LOADER_SNAPSHOT" "$SESSION_TITLE_SNAPSHOT"
  echo "  could not snapshot PUI session-title extension; update aborted" >&2
  exit 1
fi
if ! node "$BACKGROUND_PATCH" snapshot "$BACKGROUND_SNAPSHOT" >/dev/null 2>&1; then
  rm -rf -- "$BACKGROUND_SNAPSHOT" "$SUBAGENTS_SNAPSHOT" "$REASONING_SNAPSHOT" "$SKILL_LOADER_SNAPSHOT" "$SESSION_TITLE_SNAPSHOT"
  echo "  could not snapshot pi-background-tasks compatibility artifacts; update aborted" >&2
  exit 1
fi
if ! node "$SUBAGENTS_PATCH" snapshot "$SUBAGENTS_SNAPSHOT" >/dev/null 2>&1; then
  rm -rf -- "$BACKGROUND_SNAPSHOT" "$SUBAGENTS_SNAPSHOT" "$REASONING_SNAPSHOT" "$SKILL_LOADER_SNAPSHOT" "$SESSION_TITLE_SNAPSHOT"
  echo "  could not snapshot pi-subagents prompt artifacts; update aborted" >&2
  exit 1
fi
if ! node "$REASONING_PATCH" snapshot "$REASONING_SNAPSHOT" "$SCRIPT_DIR" "$REASONING_PIWEB_ROOT" "$REASONING_STANDALONE_ROOT" >/dev/null 2>&1; then
  rm -rf -- "$BACKGROUND_SNAPSHOT" "$SUBAGENTS_SNAPSHOT" "$REASONING_SNAPSHOT" "$SKILL_LOADER_SNAPSHOT" "$SESSION_TITLE_SNAPSHOT"
  echo "  could not snapshot Responses reasoning-summary artifacts; update aborted" >&2
  exit 1
fi
restore_background_patch_on_exit() {
  status=$?
  trap - EXIT
  snapshot_resolved=0
  if [ "$BACKGROUND_PATCH_COMMITTED" -eq 0 ]; then
    if node "$BACKGROUND_PATCH" restore-snapshot "$BACKGROUND_SNAPSHOT" >/dev/null 2>&1; then
      snapshot_resolved=1
    else
      echo "  FAILED to restore pi-background-tasks compatibility artifacts; recovery snapshot retained at $BACKGROUND_SNAPSHOT" >&2
      status=1
    fi
  fi
  if [ "$snapshot_resolved" -eq 1 ]; then rm -rf -- "$BACKGROUND_SNAPSHOT"; fi
  subagents_resolved=0
  if [ "$SUBAGENTS_PATCH_COMMITTED" -eq 0 ]; then
    if node "$SUBAGENTS_PATCH" restore-snapshot "$SUBAGENTS_SNAPSHOT" >/dev/null 2>&1; then
      subagents_resolved=1
    else
      echo "  FAILED to restore pi-subagents prompt artifacts; recovery snapshot retained at $SUBAGENTS_SNAPSHOT" >&2
      status=1
    fi
  fi
  if [ "$subagents_resolved" -eq 1 ]; then rm -rf -- "$SUBAGENTS_SNAPSHOT"; fi
  reasoning_resolved=0
  if [ "$REASONING_PATCH_COMMITTED" -eq 0 ]; then
    if node "$REASONING_PATCH" restore-snapshot "$REASONING_SNAPSHOT" "$SCRIPT_DIR" "$REASONING_PIWEB_ROOT" "$REASONING_STANDALONE_ROOT" >/dev/null 2>&1; then
      reasoning_resolved=1
    else
      echo "  FAILED to restore Responses reasoning-summary artifacts; recovery snapshot retained at $REASONING_SNAPSHOT" >&2
      status=1
    fi
  fi
  if [ "$reasoning_resolved" -eq 1 ]; then rm -rf -- "$REASONING_SNAPSHOT"; fi
  skill_loader_resolved=0
  if [ "$SKILL_LOADER_SNAPSHOT_COMMITTED" -eq 0 ]; then
    if node "$SKILL_LOADER_EXTENSION" restore-snapshot "$SKILL_LOADER_SNAPSHOT" "$SCRIPT_DIR" >/dev/null 2>&1; then
      skill_loader_resolved=1
    else
      echo "  FAILED to restore PUI skill-loader extension; recovery snapshot retained at $SKILL_LOADER_SNAPSHOT" >&2
      status=1
    fi
  fi
  if [ "$skill_loader_resolved" -eq 1 ]; then rm -rf -- "$SKILL_LOADER_SNAPSHOT"; fi
  session_title_resolved=0
  if [ "$SESSION_TITLE_SNAPSHOT_COMMITTED" -eq 0 ]; then
    if node "$SESSION_TITLE_EXTENSION" restore-snapshot "$SESSION_TITLE_SNAPSHOT" "$SCRIPT_DIR" >/dev/null 2>&1; then
      session_title_resolved=1
    else
      echo "  FAILED to restore PUI session-title extension; recovery snapshot retained at $SESSION_TITLE_SNAPSHOT" >&2
      status=1
    fi
  fi
  if [ "$session_title_resolved" -eq 1 ]; then rm -rf -- "$SESSION_TITLE_SNAPSHOT"; fi
  exit "$status"
}
trap restore_background_patch_on_exit EXIT

for f in "$PI_WEB_ACCESS" "$MCP_SHARED" "$PI_SETTINGS" "$PI_FFF_FEATURES" "$PI_GOAL" "$ASK_USER_CONFIG" "$PUI_SUBAGENTS_CONFIG" "$PUI_REASONING_SUMMARIES" "$PUI_SESSION_TITLES"; do
  if [ -f "$f" ]; then
    BK="$(node "$LIB" backup "$f" | tail -1)" || { echo "  backup failed: $f" >&2; exit 1; }
    echo "  backed up: $BK"
    BACKUP_FILES+=("$BK")
  fi
done
if [ -f "$PUI_REASONING_SUMMARIES" ] && ! node "$LIB" validate-reasoning-summary-modes "$PUI_REASONING_SUMMARIES" >/dev/null 2>&1; then
  echo "  invalid reasoning-summary configuration backed up and left unchanged: $PUI_REASONING_SUMMARIES" >&2
  exit 1
fi
if [ -f "$PUI_SESSION_TITLES" ] && ! node "$LIB" validate-session-titles "$PUI_SESSION_TITLES" >/dev/null 2>&1; then
  echo "  invalid session-title configuration backed up and left unchanged: $PUI_SESSION_TITLES" >&2
  exit 1
fi

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

# Apply the temporary exact-version Pi #8782 runtime backport before any
# restart. This is fatal: an unpatched PUI Pi Web is unsupported.
PIWEB_PKG_ROOT="$(npm root -g 2>/dev/null)/@agegr/pi-web"
if ! node "$SCRIPT_DIR/lib/pui-pi-8782-backport.js" apply "$SCRIPT_DIR" "$PIWEB_PKG_ROOT" >/dev/null; then
  echo "  Pi #8782 backport could not be applied; update aborted" >&2
  exit 1
fi
pui_fail pi-8782-backport
echo "  Pi #8782 backport applied to Pi Web runtime"

PI_STANDALONE_ROOT="${GLOBAL_ROOT}/@earendil-works/pi-coding-agent"
if ! node "$SCRIPT_DIR/lib/pui-reasoning-summary-patch.js" migrate-legacy "$SCRIPT_DIR" "$PIWEB_PKG_ROOT" "$PI_STANDALONE_ROOT" >/dev/null; then
  echo "  previous reasoning-summary ownership could not be migrated; update aborted" >&2
  exit 1
fi

# Re-apply PUI icon override (npm update overwrites the package files).
PUI_ICONS_DIR="$SCRIPT_DIR/assets/icons"
if [ -d "$PUI_ICONS_DIR" ]; then
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

# Apply after branding because both transforms own Pi Web page bundles.
if ! node "$SCRIPT_DIR/lib/pui-reasoning-summary-patch.js" apply "$SCRIPT_DIR" "$PIWEB_PKG_ROOT" "$PI_STANDALONE_ROOT" >/dev/null; then
  echo "  reasoning-summary compatibility patch could not be applied; update aborted" >&2
  exit 1
fi
pui_fail reasoning-summary-patch
echo "  Responses reasoning-summary display patch applied to Pi Web and standalone Pi"
if ! node "$SCRIPT_DIR/lib/pui-web-integration.js" finalize "$SCRIPT_DIR" "$PIWEB_PKG_ROOT" >/dev/null; then
  echo "  Pi Web update integration finalization failed; update aborted" >&2
  exit 1
fi

# Reconcile packages PUI added or retired before updating existing extensions.
package_installed() {
  node -e 'const fs=require("fs");const f=process.argv[1],spec=process.argv[2];if(!fs.existsSync(f))process.exit(1);const s=JSON.parse(fs.readFileSync(f,"utf8"));const p=Array.isArray(s.packages)?s.packages:[];process.exit(p.some(x=>typeof x==="string"&&(x===spec||x.startsWith(spec+"@")))?0:1)' "$PI_SETTINGS" "$1"
}
for spec in $(node -e 'const s=require(process.argv[1]);for(const p of s.retiredPiPackages||[])console.log(p)' "$STACK"); do
  if package_installed "$spec"; then
    echo "  retiring $spec..."
    if ! run_pi_bounded remove "$spec"; then echo "  failed to retire $spec" >&2; exit 1; fi
  fi
done
for spec in $(node -e 'const s=require(process.argv[1]);for(const p of s.piPackages)console.log(p)' "$STACK"); do
  echo "  reconciling managed extension $spec..."
  if ! run_pi_bounded install "$spec"; then echo "  failed to install $spec" >&2; exit 1; fi
  node "$SCRIPT_DIR/lib/pui-config.js" set-package "$PI_SETTINGS" "$spec" >/dev/null || { echo "  failed to set exact managed pin for $spec" >&2; exit 1; }
done
pui_fail package-reconciliation

ASK_GUIDANCE="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.askUserQuestion.guidance))' "$STACK")"
node "$LIB" set-owned-fields "$ASK_USER_CONFIG" guidance "$ASK_GUIDANCE" >/dev/null || { echo "  ask-user-question guidance reconciliation failed" >&2; exit 1; }
echo "  ask-user-question guidance reconciled"

REASONING_SUMMARY_DEFAULTS="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.reasoningSummaries.modelModes))' "$STACK")"
node "$LIB" ensure-reasoning-summary-modes "$PUI_REASONING_SUMMARIES" "$REASONING_SUMMARY_DEFAULTS" >/dev/null || { echo "  reasoning-summary configuration is invalid and was not overwritten" >&2; exit 1; }
echo "  reasoning-summary modes ready: $PUI_REASONING_SUMMARIES"

SESSION_TITLE_DEFAULTS="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.sessionTitles.models))' "$STACK")"
node "$LIB" ensure-session-titles "$PUI_SESSION_TITLES" "$SESSION_TITLE_DEFAULTS" >/dev/null || { echo "  session-title configuration is invalid and was not overwritten" >&2; exit 1; }
echo "  session-title models ready: $PUI_SESSION_TITLES"

SUBAGENT_DEFAULT_MAPPINGS="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.subagents.modelMappings))' "$STACK")"
node "$LIB" reconcile-model-mappings "$PUI_SUBAGENTS_CONFIG" "$SUBAGENT_DEFAULT_MAPPINGS" >/dev/null || { echo "  subagent model mapping reconciliation failed" >&2; exit 1; }
echo "  subagent fuzzy model mappings reconciled: $PUI_SUBAGENTS_CONFIG"

# Reconcile pi-fff feature state: suppress startup notices while keeping
# PUI's fuzzy features active, and remove retired custom agent tools.
FFF_CFG="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify({enabledFeatures:s.fff.enabledFeatures}))' "$STACK")"
node "$LIB" merge-object "$PI_FFF_FEATURES" "$FFF_CFG" >/dev/null || { echo "  pi-fff feature state reconciliation failed" >&2; exit 1; }
FFF_RETIRED="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.fff.retiredFeatures||[]))' "$STACK")"
node "$LIB" remove-array-items "$PI_FFF_FEATURES" enabledFeatures "$FFF_RETIRED" >/dev/null || { echo "  pi-fff retired feature removal failed" >&2; exit 1; }
echo "  pi-fff feature state reconciled (startup notices disabled; custom agent tools disabled)"

# Reconcile pi-goal settings: unlimited automatic turns with a readable status line.
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
if ! node "$BACKGROUND_PATCH" apply >/dev/null 2>&1; then
  echo "  pi-background-tasks compatibility patch could not be applied (version or bundle drift); update aborted." >&2
  exit 1
fi
echo "  pi-background-tasks compact guidance and runtime isolation applied"
if ! node "$SUBAGENTS_PATCH" apply >/dev/null 2>&1; then
  echo "  pi-subagents policy patch could not be applied (version or metadata drift); update aborted." >&2
  exit 1
fi
echo "  pi-subagents policy applied"

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
MCP_FOOTER_CFG="$(node -e 'process.stdout.write(JSON.stringify({settings:{mcpFooterStatus:process.argv[1]}}))' "$MCP_FOOTER_STATUS")"
node "$LIB" merge-object "$MCP_SHARED" "$MCP_FOOTER_CFG" >/dev/null || { echo "  MCP footer status reconciliation failed" >&2; exit 1; }
echo "  MCP footer status configured (mcpFooterStatus=$MCP_FOOTER_STATUS)"
pui_fail config-migration
node "$SCRIPT_DIR/lib/pui-update-extension.js" install "$SCRIPT_DIR" >/dev/null || { echo "  PUI update extension replacement failed" >&2; exit 1; }
node "$SCRIPT_DIR/lib/pui-skill-loader-extension.js" install "$SCRIPT_DIR" >/dev/null || { echo "  PUI skill loader extension replacement failed" >&2; exit 1; }
node "$SCRIPT_DIR/lib/pui-reasoning-summary-extension.js" install "$SCRIPT_DIR" >/dev/null || { echo "  PUI reasoning-summary extension replacement failed" >&2; exit 1; }
node "$SCRIPT_DIR/lib/pui-session-title-extension.js" install "$SCRIPT_DIR" >/dev/null || { echo "  PUI session-title extension replacement failed" >&2; exit 1; }
pui_fail extension-replacement
echo "  refreshing model catalogs..."
if ! run_pi_bounded update --models; then echo "  model catalog refresh failed" >&2; exit 1; fi

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
PUI_VERSION="$(node -p 'require(process.argv[1]).version' "$SCRIPT_DIR/package.json")"
set +e
node "$BACKGROUND_PATCH" spawn-guard "$BACKGROUND_SNAPSHOT" "$PUI_VERSION" >/dev/null
BACKGROUND_GUARD_EXIT=$?
set -e
if [ "$BACKGROUND_GUARD_EXIT" -eq 75 ] || [ "$BACKGROUND_GUARD_EXIT" -eq 76 ]; then
  # A direct staged apply has no outer validation; a checkpoint route already
  # has one transaction-level guard retaining the original snapshot.
  BACKGROUND_PATCH_COMMITTED=1
  rm -rf -- "$BACKGROUND_SNAPSHOT"
elif [ "$BACKGROUND_GUARD_EXIT" -ne 0 ]; then
  echo "  could not start the outer-transaction background prompt rollback guard" >&2
  exit 1
else
  BACKGROUND_GUARD_READY="$BACKGROUND_SNAPSHOT/guard-ready"
  for _ in $(seq 1 50); do
    [ -f "$BACKGROUND_GUARD_READY" ] && break
    sleep 0.1
  done
  [ -f "$BACKGROUND_GUARD_READY" ] || { echo "  background prompt rollback guard did not become ready" >&2; exit 1; }
  BACKGROUND_PATCH_COMMITTED=1
fi
set +e
node "$SUBAGENTS_PATCH" spawn-guard "$SUBAGENTS_SNAPSHOT" "$PUI_VERSION" >/dev/null
SUBAGENTS_GUARD_EXIT=$?
set -e
if [ "$SUBAGENTS_GUARD_EXIT" -eq 75 ] || [ "$SUBAGENTS_GUARD_EXIT" -eq 76 ]; then
  # A direct staged apply has no outer validation; a checkpoint route already
  # has one transaction-level guard retaining the original snapshot.
  SUBAGENTS_PATCH_COMMITTED=1
  rm -rf -- "$SUBAGENTS_SNAPSHOT"
elif [ "$SUBAGENTS_GUARD_EXIT" -ne 0 ]; then
  echo "  could not start the outer-transaction subagents prompt rollback guard" >&2
  exit 1
else
  SUBAGENTS_GUARD_READY="$SUBAGENTS_SNAPSHOT/guard-ready"
  for _ in $(seq 1 50); do
    [ -f "$SUBAGENTS_GUARD_READY" ] && break
    sleep 0.1
  done
  [ -f "$SUBAGENTS_GUARD_READY" ] || { echo "  subagents prompt rollback guard did not become ready" >&2; exit 1; }
  SUBAGENTS_PATCH_COMMITTED=1
fi
set +e
node "$SKILL_LOADER_EXTENSION" spawn-guard "$SKILL_LOADER_SNAPSHOT" "$PUI_VERSION" "$SCRIPT_DIR" >/dev/null
SKILL_LOADER_GUARD_EXIT=$?
set -e
if [ "$SKILL_LOADER_GUARD_EXIT" -eq 75 ] || [ "$SKILL_LOADER_GUARD_EXIT" -eq 76 ]; then
  SKILL_LOADER_SNAPSHOT_COMMITTED=1
  rm -rf -- "$SKILL_LOADER_SNAPSHOT"
elif [ "$SKILL_LOADER_GUARD_EXIT" -ne 0 ]; then
  echo "  could not start the outer-transaction skill-loader rollback guard" >&2
  exit 1
else
  SKILL_LOADER_GUARD_READY="$SKILL_LOADER_SNAPSHOT/guard-ready"
  for _ in $(seq 1 50); do
    [ -f "$SKILL_LOADER_GUARD_READY" ] && break
    sleep 0.1
  done
  [ -f "$SKILL_LOADER_GUARD_READY" ] || { echo "  skill-loader rollback guard did not become ready" >&2; exit 1; }
  SKILL_LOADER_SNAPSHOT_COMMITTED=1
fi
set +e
node "$SESSION_TITLE_EXTENSION" spawn-guard "$SESSION_TITLE_SNAPSHOT" "$PUI_VERSION" "$SCRIPT_DIR" >/dev/null
SESSION_TITLE_GUARD_EXIT=$?
set -e
if [ "$SESSION_TITLE_GUARD_EXIT" -eq 75 ] || [ "$SESSION_TITLE_GUARD_EXIT" -eq 76 ]; then
  SESSION_TITLE_SNAPSHOT_COMMITTED=1
  rm -rf -- "$SESSION_TITLE_SNAPSHOT"
elif [ "$SESSION_TITLE_GUARD_EXIT" -ne 0 ]; then
  echo "  could not start the outer-transaction session-title rollback guard" >&2
  exit 1
else
  SESSION_TITLE_GUARD_READY="$SESSION_TITLE_SNAPSHOT/guard-ready"
  for _ in $(seq 1 50); do
    [ -f "$SESSION_TITLE_GUARD_READY" ] && break
    sleep 0.1
  done
  [ -f "$SESSION_TITLE_GUARD_READY" ] || { echo "  session-title rollback guard did not become ready" >&2; exit 1; }
  SESSION_TITLE_SNAPSHOT_COMMITTED=1
fi
set +e
node "$REASONING_PATCH" spawn-guard "$REASONING_SNAPSHOT" "$PUI_VERSION" "$SCRIPT_DIR" "$REASONING_PIWEB_ROOT" "$REASONING_STANDALONE_ROOT" >/dev/null
REASONING_GUARD_EXIT=$?
set -e
if [ "$REASONING_GUARD_EXIT" -eq 75 ] || [ "$REASONING_GUARD_EXIT" -eq 76 ]; then
  REASONING_PATCH_COMMITTED=1
  rm -rf -- "$REASONING_SNAPSHOT"
elif [ "$REASONING_GUARD_EXIT" -ne 0 ]; then
  echo "  could not start the outer-transaction reasoning-summary rollback guard" >&2
  exit 1
else
  REASONING_GUARD_READY="$REASONING_SNAPSHOT/guard-ready"
  for _ in $(seq 1 50); do
    [ -f "$REASONING_GUARD_READY" ] && break
    sleep 0.1
  done
  [ -f "$REASONING_GUARD_READY" ] || { echo "  reasoning-summary rollback guard did not become ready" >&2; exit 1; }
  REASONING_PATCH_COMMITTED=1
fi

echo
echo "Update complete: all doctor checks passed."
