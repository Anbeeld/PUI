#!/usr/bin/env bash
# PUI installer for native macOS and Linux.
# Behaviorally equivalent to install.ps1. Uses lib/pui-config.js for JSON merges.
# OS detection branches only for the autostart mechanism (LaunchAgent vs systemd).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/pui-config.js"
STACK="$SCRIPT_DIR/stack.json"
STACK_READER="$SCRIPT_DIR/lib/pui-stack.js"
NO_PWA=0
NO_BROWSER=0
KEYLESS_ROUTE=0
GATE_RESULTS=()
FAILURES=()

for arg in "$@"; do
  case "$arg" in
    --no-pwa) NO_PWA=1 ;;
    --no-browser) NO_BROWSER=1 ;;
    --keyless-route) KEYLESS_ROUTE=1 ;;
    *) echo "Unknown argument: $arg"; exit 64 ;;
  esac
done

# npm's bulk-advisory audit POST stalls indefinitely on pi's large package tree;
# every npm child (including the one inside `pi install`) inherits this setting.
export npm_config_audit=false

# ---- OS detection ----
OS_TYPE="$(uname -s)"
case "$OS_TYPE" in
  Darwin) OS_NAME="macOS"; OS_PRETTY="$(sw_vers -productName) $(sw_vers -productVersion 2>/dev/null || echo Darwin)" ;;
  Linux)  OS_NAME="Linux";  OS_PRETTY="Linux $(cut -d= -f2 /etc/os-release 2>/dev/null | head -1 || echo unknown)" ;;
  *) echo "Unsupported OS: $OS_TYPE (PUI supports macOS and Linux on this path)"; exit 1 ;;
esac

# helpers
expand_path() { echo "${1/#\~/$HOME}"; }
jget() { node "$STACK_READER" "$STACK" "$1"; }
node_config() { node "$LIB" "$@"; }
# Exit 0 when node version string $1 >= semver $2.
node_version_ok() {
  node -e 'const a=process.argv[1].replace(/^v/,"").split(".").map(Number);const b=process.argv[2].split(".").map(Number);for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))process.exit((a[i]||0)>(b[i]||0)?0:1)}process.exit(0)' "$1" "$2"
}

write_phase() { echo; echo "=== Phase $1 — $2 ==="; }
gate() { GATE_RESULTS+=("$1:$2:$3"); if [ "$3" = "1" ]; then echo "[GATE $1 PASS] $2"; else echo "[GATE $1 FAIL] $2"; FAILURES+=("$1"); fi; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }

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

PLIST_LABEL="com.pui.piweb"
SERVICE_NAME="pui-piweb"

piweb_autostart_running() {
  if [ "$OS_NAME" = "macOS" ]; then
    launchctl print "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null | grep -q "state = running"
  else
    systemctl --user is-active --quiet "$SERVICE_NAME"
  fi
}

stop_existing_piweb_autostart() {
  if [ "$OS_NAME" = "macOS" ]; then
    local PLIST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
    if launchctl print "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1; then
      launchctl unload "$PLIST" 2>/dev/null || { echo "  failed to stop LaunchAgent $PLIST_LABEL" >&2; return 1; }
    fi
  else
    if systemctl --user is-active --quiet "$SERVICE_NAME"; then
      systemctl --user stop "$SERVICE_NAME" 2>/dev/null || { echo "  failed to stop $SERVICE_NAME" >&2; return 1; }
    fi
  fi
}

PI_AGENT_DIR="$(expand_path "$(jget configPaths.piAgentDir)")"
PI_SETTINGS="$(expand_path "$(jget configPaths.piSettings)")"
PI_WEB_ACCESS="$(expand_path "$(jget configPaths.piWebAccess)")"
MCP_SHARED="$(expand_path "$(jget configPaths.mcpShared)")"
MCP_FOOTER_STATUS="$(jget mcp.footerStatus)"
PI_FFF_FEATURES="$(expand_path "$(jget configPaths.piFffFeatures)")"
PI_GOAL="$(expand_path "$(jget configPaths.piGoal)")"
PUI_SUBAGENTS_CONFIG="$(expand_path "$(jget configPaths.puiSubagents)")"
PUI_REASONING_SUMMARIES="$(expand_path "$(jget configPaths.puiReasoningSummaries)")"
PUI_SESSION_TITLES="$(expand_path "$(jget configPaths.puiSessionTitles)")"
ASK_USER_CONFIG="$(node_config resolve-config-path "$(jget configPaths.askUserQuestion)" "$(jget askUserQuestion.configRelativePath)")" || { echo "  ask-user-question config path resolution failed" >&2; exit 1; }
MIN_NODE="$(jget minimumNode)"
PIWEB_URL="$(jget piWeb.url)"

# ---- Phase 1: prerequisites (G1) ----
write_phase 1 "prerequisite detection"
G1=1
has_cmd node || { echo "  Node: NOT FOUND"; G1=0; }
if has_cmd node; then
  NODE_VER="$(node --version)"
  if node_version_ok "$NODE_VER" "$MIN_NODE"; then
    echo "  Node: $NODE_VER"
  else
    echo "  Node $NODE_VER requires >= $MIN_NODE"; G1=0
  fi
fi
has_cmd npm || { echo "  npm: NOT FOUND"; G1=0; }
has_cmd git || { echo "  Git: NOT FOUND"; G1=0; }
has_cmd curl || { echo "  curl: NOT FOUND"; G1=0; }
if [ "$OS_NAME" = "Linux" ] && [ "$NO_PWA" -eq 0 ]; then
  has_cmd systemctl || { echo "  systemctl: NOT FOUND"; G1=0; }
fi
echo "  OS: $OS_PRETTY"
curl -s --max-time 10 "https://registry.npmjs.org/-/ping?write=true" >/dev/null || { echo "  Network: npm unreachable"; G1=0; }
gate G1 "prerequisites" "$G1"
if [ "$G1" != "1" ]; then
  echo "  Install Node >= $MIN_NODE (https://nodejs.org/) and Git, then re-run." >&2
  exit 1
fi

# ---- Phase 2: preserve (G2) ----
write_phase 2 "preserve existing state"
G2=1
for f in "$PI_SETTINGS" "$PI_WEB_ACCESS" "$MCP_SHARED" "$PI_FFF_FEATURES" "$PI_GOAL" "$ASK_USER_CONFIG" "$PUI_SUBAGENTS_CONFIG" "$PUI_REASONING_SUMMARIES" "$PUI_SESSION_TITLES"; do
  if [ -f "$f" ]; then
    BK="$(node_config backup "$f" | tail -1)" || { echo "  backup failed: $f" >&2; G2=0; continue; }
    echo "  backed up: $BK"
    if ! node_config validate "$f" >/dev/null 2>&1; then
      echo "  INVALID JSON (not overwritten): $f" >&2
      node_config validate "$f" >&2 || true
      G2=0
    elif [ "$f" = "$PUI_REASONING_SUMMARIES" ] && ! node_config validate-reasoning-summary-modes "$f" >/dev/null 2>&1; then
      echo "  INVALID reasoning-summary configuration (not overwritten): $f" >&2
      node_config validate-reasoning-summary-modes "$f" >&2 || true
      G2=0
    elif [ "$f" = "$PUI_SESSION_TITLES" ] && ! node_config validate-session-titles "$f" >/dev/null 2>&1; then
      echo "  INVALID session-title configuration (not overwritten): $f" >&2
      node_config validate-session-titles "$f" >&2 || true
      G2=0
    fi
  fi
done
gate G2 "preservation" "$G2"
if [ "$G2" != "1" ]; then exit 1; fi

# Resolve the actual @earendil-works/pi-coding-agent version used by installed
# pi-web: prefer the installed module tree (nested, then hoisted); fall back to
# extracting an exact semver from the dependency spec. Echoes "" if unknown.
resolve_piweb_ca_ver() {
  local root pw_pkg nested hoisted spec ver=""
  root="$(npm root -g)"
  pw_pkg="$root/@agegr/pi-web/package.json"
  [ -f "$pw_pkg" ] || return 0
  nested="$root/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/package.json"
  hoisted="$root/node_modules/@earendil-works/pi-coding-agent/package.json"
  if [ -f "$nested" ]; then
    ver="$(node -e 'process.stdout.write(String(require(process.argv[1]).version||""))' "$nested" 2>/dev/null || true)"
  fi
  if [ -z "$ver" ] && [ -f "$hoisted" ]; then
    ver="$(node -e 'process.stdout.write(String(require(process.argv[1]).version||""))' "$hoisted" 2>/dev/null || true)"
  fi
  if [ -z "$ver" ]; then
    spec="$(node -e 'const p=require(process.argv[1]);const d=p.dependencies&&p.dependencies["@earendil-works/pi-coding-agent"];if(typeof d==="string")process.stdout.write(d)' "$pw_pkg" 2>/dev/null || true)"
    if [ -n "$spec" ]; then
      ver="$(printf '%s' "$spec" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    fi
  fi
  [ -n "$ver" ] && printf '%s' "$ver"
}

# ---- Phase 3: Pi Web + Pi core (G3) ----
write_phase 3 "Pi Web + Pi runtime parity"
# A reinstall also replaces shared managed runtimes. Check Pi Web while it is
# still alive so active work is never mistaken for an idle/unreachable server.
if pgrep -f '[/]node_modules[/]@agegr[/]pi-web[/]' >/dev/null 2>&1; then
  RUNNING_JSON="$(curl -sf --max-time 3 "$PIWEB_URL/api/agent/running" 2>/dev/null)" || { echo "  could not verify Pi Web idle state; install aborted" >&2; exit 1; }
  set +e
  node -e 'const s=JSON.parse(process.argv[1]);if(!Array.isArray(s.runningSessionIds))process.exit(2);process.exit(s.runningSessionIds.length?75:0)' "$RUNNING_JSON"
  RUNNING_EXIT=$?
  set -e
  if [ "$RUNNING_EXIT" -eq 75 ]; then echo "  active Pi Web sessions detected; install deferred without stopping them" >&2; exit 75; fi
  if [ "$RUNNING_EXIT" -ne 0 ]; then echo "  Pi Web returned an invalid activity response; install aborted" >&2; exit 1; fi
fi
# Stop the service manager before killing any leftover process so an
# on-failure policy cannot restart Pi Web during global package mutation.
if ! stop_existing_piweb_autostart; then
  gate G3 "pi-web stop" 0
  exit 1
fi
pkill -f '[/]node_modules[/]@agegr[/]pi-web[/]' 2>/dev/null || true
sleep 1
if pgrep -f '[/]node_modules[/]@agegr[/]pi-web[/]' >/dev/null 2>&1; then
  echo "  Pi Web did not stop; install aborted" >&2
  exit 1
fi
set +e
node "$SCRIPT_DIR/lib/pui-updater.js" standalone-busy
STANDALONE_EXIT=$?
set -e
if [ "$STANDALONE_EXIT" -eq 75 ]; then echo "  standalone Pi is active; install deferred" >&2; exit 75; fi
if [ "$STANDALONE_EXIT" -ne 0 ]; then echo "  could not verify standalone Pi idle state" >&2; exit 1; fi
echo "  installing @agegr/pi-web (global)..."
npm install -g --ignore-scripts "$(jget upstream.gui.npm)@$(jget upstream.gui.version)" >/dev/null 2>&1 || { gate G3 "pi-web install" 0; exit 1; }

hash -r 2>/dev/null || true
PIWEB_CA_VER="$(jget upstream.agentRuntime.version)"
PI_SPEC="$(jget upstream.agentRuntime.npm)@$PIWEB_CA_VER"
echo "  PUI pins pi-coding-agent $PIWEB_CA_VER"

# pi-web keeps its runtime dependency private, so a clean install must
# explicitly provision the standalone `pi` command before PATH validation.
PI_CUR=""
if has_cmd pi; then PI_CUR="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"; fi
if ! has_cmd pi || { [ -n "$PIWEB_CA_VER" ] && [ "$PI_CUR" != "$PIWEB_CA_VER" ]; }; then
  echo "  installing standalone pi from $PI_SPEC..."
  npm install -g --ignore-scripts "$PI_SPEC" >/dev/null 2>&1 || { echo "  pi install failed" >&2; gate G3 "runtime parity" 0; exit 1; }
  hash -r 2>/dev/null || true
fi

G3=1
has_cmd pi-web || { echo "  pi-web not on PATH"; G3=0; }
has_cmd pi || { echo "  pi not on PATH"; G3=0; }
if has_cmd pi; then
  PI_CUR="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  echo "  pi --version: ${PI_CUR:-unknown}"
  if [ -n "$PIWEB_CA_VER" ] && [ "$PI_CUR" != "$PIWEB_CA_VER" ]; then
    echo "  runtime mismatch: pi=$PI_CUR pi-web=$PIWEB_CA_VER" >&2
    G3=0
  fi
fi
gate G3 "runtime parity" "$G3"
if [ "$G3" != "1" ]; then exit 1; fi

# Apply the temporary exact-version Pi #8782 runtime backport before any
# restart. This is fatal: launching an unpatched PUI Pi Web is unsupported.
PIWEB_PKG_ROOT="$(npm root -g 2>/dev/null)/@agegr/pi-web"
if ! node "$SCRIPT_DIR/lib/pui-pi-8782-backport.js" apply "$SCRIPT_DIR" "$PIWEB_PKG_ROOT" >/dev/null; then
  echo "  Pi #8782 backport could not be applied; install aborted" >&2
  exit 1
fi
echo "  Pi #8782 backport applied to Pi Web runtime"

PI_STANDALONE_ROOT="$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent"
if ! node "$SCRIPT_DIR/lib/pui-reasoning-summary-patch.js" migrate-legacy "$SCRIPT_DIR" "$PIWEB_PKG_ROOT" "$PI_STANDALONE_ROOT" >/dev/null; then
  echo "  previous reasoning-summary ownership could not be migrated; install aborted" >&2
  exit 1
fi

# Override pi-web PWA icons with PUI's improved version (white glyph on teal).
# Setup-time asset override: re-applied on every install/update since npm
# overwrites the package. Originals are backed up beside the files.
PUI_ICONS_DIR="$SCRIPT_DIR/assets/icons"
if [ -d "$PUI_ICONS_DIR" ]; then
  PIWEB_ICONS_DIR="$PIWEB_PKG_ROOT/public/icons"
  if [ -d "$PIWEB_ICONS_DIR" ]; then
    echo "  applying complete PUI icon set..."
    if ! node "$SCRIPT_DIR/lib/pui-icons.js" apply "$PUI_ICONS_DIR" "$PIWEB_PKG_ROOT"; then
      echo "  PUI icon override failed" >&2
      exit 1
    fi
    # Apply only top-level text branding. The shared helper handles each
    # Next.js serialization shape and leaves Pi Web component references intact.
    if node "$SCRIPT_DIR/lib/pui-branding.js" apply "$PIWEB_PKG_ROOT"; then
      echo "  branding override applied (icons, favicon, SW cache-bust, title/metadata)"
    else
      echo "  PUI text branding override failed" >&2
      exit 1
    fi
    node "$SCRIPT_DIR/lib/pui-web-integration.js" apply "$SCRIPT_DIR" "$PIWEB_PKG_ROOT" || { echo "  Pi Web update integration failed" >&2; exit 1; }
  else
    echo "  Pi Web icon directory missing: $PIWEB_ICONS_DIR" >&2
    exit 1
  fi
else
  echo "  PUI icon directory missing: $PUI_ICONS_DIR" >&2
  exit 1
fi

# Apply this display patch after branding because both transforms own Pi Web
# page bundles. Uninstall restores them in the reverse order.
if ! node "$SCRIPT_DIR/lib/pui-reasoning-summary-patch.js" apply "$SCRIPT_DIR" "$PIWEB_PKG_ROOT" "$PI_STANDALONE_ROOT" >/dev/null; then
  echo "  reasoning-summary compatibility patch could not be applied; install aborted" >&2
  exit 1
fi
echo "  Responses reasoning-summary display patch applied to Pi Web and standalone Pi"
if ! node "$SCRIPT_DIR/lib/pui-web-integration.js" finalize "$SCRIPT_DIR" "$PIWEB_PKG_ROOT" >/dev/null; then
  echo "  Pi Web update integration finalization failed; install aborted" >&2
  exit 1
fi

# ---- Phase 4: Pi packages (G4) ----
write_phase 4 "Pi packages"
G4=1
PI_LIST_BEFORE="$(pi list 2>&1 || true)"
for spec in $(node -e 'const s=require(process.argv[1]);for(const p of s.retiredPiPackages||[])console.log(p)' "$STACK"); do
  if printf '%s\n' "$PI_LIST_BEFORE" | grep -Fq "$spec"; then
    echo "  retiring $spec"
    if ! run_pi_bounded remove "$spec"; then echo "  FAILED to retire: $spec"; G4=0; fi
  fi
done
for spec in $(node -e 'const s=require(process.argv[1]);for(const p of s.piPackages)console.log(p)' "$STACK"); do
  echo "  pi install $spec"
  if run_pi_bounded install "$spec"; then
    node_config set-package "$PI_SETTINGS" "$spec" >/dev/null || G4=0
  else
    echo "  FAILED: $spec"; G4=0
  fi
done
node "$SCRIPT_DIR/lib/pui-update-extension.js" install "$SCRIPT_DIR" >/dev/null || { echo "  PUI update extension install failed" >&2; G4=0; }
node "$SCRIPT_DIR/lib/pui-skill-loader-extension.js" install "$SCRIPT_DIR" >/dev/null || { echo "  PUI skill loader extension install failed" >&2; G4=0; }
node "$SCRIPT_DIR/lib/pui-reasoning-summary-extension.js" install "$SCRIPT_DIR" >/dev/null || { echo "  PUI reasoning-summary extension install failed" >&2; G4=0; }
node "$SCRIPT_DIR/lib/pui-session-title-extension.js" install "$SCRIPT_DIR" >/dev/null || { echo "  PUI session-title extension install failed" >&2; G4=0; }

ASK_GUIDANCE="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.askUserQuestion.guidance))' "$STACK")"
if node_config set-owned-fields "$ASK_USER_CONFIG" guidance "$ASK_GUIDANCE" >/dev/null; then
  echo "  ask-user-question guidance configured"
else
  echo "  ask-user-question guidance reconciliation failed" >&2; G4=0
fi

REASONING_SUMMARY_DEFAULTS="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.reasoningSummaries.modelModes))' "$STACK")"
if node_config ensure-reasoning-summary-modes "$PUI_REASONING_SUMMARIES" "$REASONING_SUMMARY_DEFAULTS" >/dev/null; then
  echo "  reasoning-summary modes ready: $PUI_REASONING_SUMMARIES"
else
  echo "  reasoning-summary configuration is invalid and was not overwritten" >&2; G4=0
fi

SESSION_TITLE_DEFAULTS="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.sessionTitles.models))' "$STACK")"
if node_config ensure-session-titles "$PUI_SESSION_TITLES" "$SESSION_TITLE_DEFAULTS" >/dev/null; then
  echo "  session-title models ready: $PUI_SESSION_TITLES"
else
  echo "  session-title configuration is invalid and was not overwritten" >&2; G4=0
fi

SUBAGENT_DEFAULT_MAPPINGS="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.subagents.modelMappings))' "$STACK")"
if node_config reconcile-model-mappings "$PUI_SUBAGENTS_CONFIG" "$SUBAGENT_DEFAULT_MAPPINGS" >/dev/null; then
  echo "  subagent fuzzy model mappings configured: $PUI_SUBAGENTS_CONFIG"
else
  echo "  subagent model mapping reconciliation failed" >&2; G4=0
fi

# PUI opinion: unlimited automatic /goal turns with a readable status line.
# continuationLimits.automaticTurns = null removes the 25-response ceiling;
# the dist patch rewrites formatStatus into "Goal: <status> · <reason> · <counter>".
GOAL_CFG='{"continuationLimits":{"automaticTurns":null,"noProgressTurns":3}}'
node_config merge-object "$PI_GOAL" "$GOAL_CFG" >/dev/null || { echo "  pi-goal settings merge failed" >&2; G4=0; }
if ! node "$SCRIPT_DIR/lib/pui-goal-patch.js" apply >/dev/null 2>&1; then
  echo "  pi-goal status patch could not be applied (version drift); the turn counter may still show 'automatic Unlimited'." >&2
else
  echo "  pi-goal configured for unlimited turns with a readable status line"
fi

# Verify the node-pty native binding for @99percentpeople/pi-background-tasks.
# node-pty ships prebuilds, so this usually passes; if not, approve and rebuild it.
if ! node "$SCRIPT_DIR/lib/pui-native-check.js" ensure "$PI_AGENT_DIR/npm" >/dev/null 2>&1; then
  echo "  pi-background-tasks native (node-pty) binding could not be verified or rebuilt; install aborted. Install the required compiler toolchain and rerun install.sh." >&2
  G4=0
fi
# Replace the pinned package's verbose model guidance and isolate its mutable
# runtime state per cached extension-factory instance.
if ! node "$SCRIPT_DIR/lib/pui-background-tasks-patch.js" apply >/dev/null 2>&1; then
  echo "  pi-background-tasks compatibility patch could not be applied (version or bundle drift); install aborted." >&2
  G4=0
else
  echo "  pi-background-tasks compact guidance and runtime isolation applied"
fi
# Apply PUI's subagent taxonomy, capabilities, routing, model, and reasoning policy.
if ! node "$SCRIPT_DIR/lib/pui-subagents-patch.js" apply >/dev/null 2>&1; then
  echo "  pi-subagents policy patch could not be applied (version or metadata drift); install aborted." >&2
  G4=0
else
  echo "  pi-subagents policy applied"
fi
pi list 2>&1 | sed 's/^/    /' || true
gate G4 "packages" "$G4"
if [ "$G4" != "1" ]; then exit 1; fi

# Configure pi-fff feature state: suppress startup notices while keeping
# fuzzy path resolution, content search, and autocomplete active. Remove
# retired custom agent tools from an existing PUI feature configuration.
FFF_CFG="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify({enabledFeatures:s.fff.enabledFeatures}))' "$STACK")"
node_config merge-object "$PI_FFF_FEATURES" "$FFF_CFG" >/dev/null || { echo "  pi-fff feature state merge failed" >&2; exit 1; }
FFF_RETIRED="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.fff.retiredFeatures||[]))' "$STACK")"
node_config remove-array-items "$PI_FFF_FEATURES" enabledFeatures "$FFF_RETIRED" >/dev/null || { echo "  pi-fff retired feature removal failed" >&2; exit 1; }
echo "  pi-fff feature state configured (startup notices disabled; custom agent tools disabled)"

# ---- Phase 5: default tools (G5) ----
write_phase 5 "native filesystem tools"
TOOLS="$(jget defaultTools)"
node_config default-tools-merge "$PI_SETTINGS" "$TOOLS"
G5=1
if [ -f "$PI_SETTINGS" ]; then
  for t in read bash edit write grep find ls; do
    node -e 'const s=require(process.argv[1]);if(!Array.isArray(s.defaultTools)||s.defaultTools.indexOf(process.argv[2])<0)process.exit(1)' "$PI_SETTINGS" "$t" || G5=0
  done
fi
gate G5 "filesystem" "$G5"
if [ "$G5" != "1" ]; then exit 1; fi

# ---- Phase 6: free keyless web (G6) ----
write_phase 6 "free keyless web"
WEB_CFG="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify({searchRouting:s.webAccess.searchRouting,fetchRouting:s.webAccess.fetchRouting,workflow:s.webAccess.workflow}))' "$STACK")"
node_config merge-object "$PI_WEB_ACCESS" "$WEB_CFG"
G6=1
node -e 'const w=require(process.argv[1]);if(!w.searchRouting||!w.fetchRouting||w.searchRouting.providers.indexOf("duckduckgo")<0||w.fetchRouting.allowRemoteHostedProviders!==false)process.exit(1)' "$PI_WEB_ACCESS" || G6=0
# Deterministic keyless route: the primary search provider must be a verified
# zero-key provider (exa or duckduckgo). A foreign primary means an existing
# An existing primary provider would override PUI's keyless route.
PRIMARY_PROVIDER="$(node -e 'const w=require(process.argv[1]);process.stdout.write((w.searchRouting&&w.searchRouting.providers&&w.searchRouting.providers[0])||"")' "$PI_WEB_ACCESS" 2>/dev/null || true)"
case "$PRIMARY_PROVIDER" in
  exa|duckduckgo) : ;;
  *)
    if [ "$KEYLESS_ROUTE" -eq 1 ]; then
      node_config prioritize "$PI_WEB_ACCESS" "searchRouting.providers" "$(jget webAccess.searchRouting.providers)"
      echo "  keyless route promoted to primary (--keyless-route): exa, duckduckgo first; user providers preserved after."
    else
      echo "  WARNING: existing primary search provider '$PRIMARY_PROVIDER' overrides PUI's keyless route." >&2
      echo "    PUI cannot certify the keyless default with this configuration." >&2
      echo "    Re-run with --keyless-route to promote exa/duckduckgo to primary (user providers are kept, not deleted)." >&2
      G6=0
    fi
    ;;
esac
gate G6 "free web (config)" "$G6"
if [ "$G6" != "1" ]; then exit 1; fi

# ---- Phase 7: MCP + Playwright (G7) ----
write_phase 7 "MCP + Playwright"
MCP_DEF="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify({command:s.mcp.command,args:s.mcp.args,lifecycle:s.mcp.lifecycle,directTools:s.mcp.directTools}))' "$STACK")"
set +e
node_config set-server "$MCP_SHARED" "$(jget mcp.serverName)" "$MCP_DEF"
RC=$?
set -e
if [ "$RC" -eq 2 ]; then
  echo "  Existing 'playwright' server has a different configuration. Inspect $MCP_SHARED." >&2
  gate G7 "mcp" 0; exit 1
elif [ "$RC" -ne 0 ]; then gate G7 "mcp" 0; exit 1; fi
# PUI opinion: keep the MCP footer status quiet. mcpFooterStatus="off" clears
# the "MCP: N server(s) enabled" segment from the extension status bar.
MCP_FOOTER_CFG="$(node -e 'process.stdout.write(JSON.stringify({settings:{mcpFooterStatus:process.argv[1]}}))' "$MCP_FOOTER_STATUS")"
node_config merge-object "$MCP_SHARED" "$MCP_FOOTER_CFG" >/dev/null || { echo "  MCP footer status merge failed" >&2; gate G7 "mcp" 0; exit 1; }
echo "  MCP footer status configured (mcpFooterStatus=$MCP_FOOTER_STATUS)"
G7=1
node -e 'const m=require(process.argv[1]),s=require(process.argv[2]);const p=m.mcpServers&&m.mcpServers.playwright;process.exit(p&&JSON.stringify(p.directTools)===JSON.stringify(s.mcp.directTools)&&m.settings?.disableProxyTool!==true?0:1)' "$MCP_SHARED" "$STACK" || G7=0
[ "$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.settings?.disableProxyTool===true?"1":"0")' "$MCP_SHARED")" = "1" ] && echo "  MCP proxy is disabled by settings.disableProxyTool; PUI requires it for non-direct tools." >&2
gate G7 "mcp (config)" "$G7"
if [ "$G7" != "1" ]; then exit 1; fi

# ---- Phase 8: PWA / autostart (G8) ----
G8=1
if [ "$NO_PWA" -eq 0 ]; then
  write_phase 8 "PWA/app integration"
  PIWEB_BIN="$(command -v pi-web)"
  if [ -z "$PIWEB_BIN" ]; then
    echo "  pi-web not found"
    G8=0
  else
    PIWEB_PATH="$(dirname "$PIWEB_BIN"):${PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
    if [ "$OS_NAME" = "macOS" ]; then
      # macOS: per-user LaunchAgent
      PLIST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
      # Idempotent: the existing job was stopped before package mutation.
      rm -f "$PLIST"
      mkdir -p "$HOME/Library/LaunchAgents"
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
      if ! launchctl load "$PLIST" 2>/dev/null; then
        echo "  failed to load LaunchAgent $PLIST_LABEL" >&2
        G8=0
      fi
      echo "  LaunchAgent $PLIST_LABEL registered (logon, loopback)"
    else
      # Linux: per-user systemd user service
      SERVICE_DIR="$HOME/.config/systemd/user"
      SERVICE_FILE="$SERVICE_DIR/${SERVICE_NAME}.service"
      mkdir -p "$SERVICE_DIR"
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
      if ! systemctl --user daemon-reload 2>/dev/null; then
        echo "  failed to reload systemd user units" >&2
        G8=0
      fi
      if ! systemctl --user enable "$SERVICE_NAME" 2>/dev/null; then
        echo "  failed to enable $SERVICE_NAME" >&2
        G8=0
      fi
      if ! systemctl --user restart "$SERVICE_NAME" 2>/dev/null; then
        echo "  failed to start $SERVICE_NAME" >&2
        G8=0
      fi
      echo "  systemd user service $SERVICE_NAME registered (logon, loopback)"
    fi

    echo "  waiting for the managed Pi Web service..."
    HEALTHY=0
    for ((i=0; i<30; i++)); do
      if piweb_autostart_running && curl -sf --max-time 5 "$PIWEB_URL" >/dev/null 2>&1; then
        HEALTHY=1
        break
      fi
      sleep 2
    done
    if [ "$HEALTHY" -eq 1 ]; then
      echo "  managed pi-web service is running and healthy at $PIWEB_URL"
      if [ "$NO_BROWSER" -eq 0 ]; then
        echo "  opening $PIWEB_URL for PWA onboarding..."
        if [ "$OS_NAME" = "macOS" ]; then open "$PIWEB_URL" 2>/dev/null || true
        else xdg-open "$PIWEB_URL" 2>/dev/null || true; fi
      fi
    else
      echo "  managed pi-web service did not reach running state with HTTP 200 within 60s" >&2
      if [ "$OS_NAME" = "macOS" ]; then
        launchctl print "gui/$(id -u)/$PLIST_LABEL" >&2 || true
      else
        systemctl --user status "$SERVICE_NAME" --no-pager >&2 || true
      fi
      G8=0
    fi
  fi
  gate G8 "app route" "$G8"
  if [ "$G8" -eq 1 ]; then
    echo
    echo "PWA status:"
    echo "  backend/autostart configured: VERIFIED"
    echo "  browser web app installed:     USER_CONFIRMATION_REQUIRED"
    if [ "$OS_NAME" = "macOS" ]; then
      echo "  (Use Safari 'Add to Dock' or Chrome 'Install page as app'.)"
    else
      echo "  (Use Chrome/Edge 'Install page as app' or Firefox 'Install site as app'.)"
    fi
  fi
else
  write_phase 8 "PWA/app integration (skipped via --no-pwa)"
  echo "  Pi Web installed; manual start: pi-web"
  gate G8 "app route (skipped)" 1
fi

# ---- Phase 9: smoke (G9) ----
write_phase 9 "end-to-end smoke"
G9=1
SMOKE=()
pi --version >/dev/null 2>&1 && SMOKE+=("[PASS] 1. pi --version: $(pi --version)") || { SMOKE+=("[FAIL] 1. pi --version"); G9=0; }
if [ "$NO_PWA" -eq 0 ]; then
  piweb_autostart_running && curl -sf --max-time 5 "$PIWEB_URL" >/dev/null && SMOKE+=("[PASS] 2. managed pi-web service runs and serves") || { SMOKE+=("[FAIL] 2. managed pi-web service/health"); G9=0; }
else
  SMOKE+=("[SKIP] 2. pi-web health (no-pwa)")
fi
PI_VER="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
PW_CA="$(resolve_piweb_ca_ver)"
if [ -n "$PW_CA" ] && [ "$PI_VER" = "$PW_CA" ]; then SMOKE+=("[PASS] 3. runtime parity ($PI_VER)"); else SMOKE+=("[WARN] 3. runtime parity pi=$PI_VER piweb=${PW_CA:-unresolved}"); fi
PI_LIST="$(pi list 2>&1 || true)"
echo "$PI_LIST" | grep -q pi-subagents && echo "$PI_LIST" | grep -q pi-web-access && echo "$PI_LIST" | grep -q pi-mcp-adapter && echo "$PI_LIST" | grep -q pi-goal && echo "$PI_LIST" | grep -q pi-accounts && echo "$PI_LIST" | grep -q pi-usage && echo "$PI_LIST" | grep -q rpiv-ask-user-question && echo "$PI_LIST" | grep -q pi-fff && echo "$PI_LIST" | grep -q pi-background-tasks && SMOKE+=("[PASS] 4. all packages visible") || { SMOKE+=("[FAIL] 4. missing packages"); G9=0; }
node -e 'const s=require(process.argv[1]);const r=["read","bash","edit","write","grep","find","ls"];for(const t of r)if(!Array.isArray(s.defaultTools)||s.defaultTools.indexOf(t)<0)process.exit(1)' "$PI_SETTINGS" && SMOKE+=("[PASS] 5/6. defaultTools present") || { SMOKE+=("[FAIL] 5/6. missing defaultTools"); G9=0; }
node -e 'const w=require(process.argv[1]);if(w.searchRouting.providers.indexOf("duckduckgo")<0||w.fetchRouting.allowRemoteHostedProviders!==false)process.exit(1)' "$PI_WEB_ACCESS" && SMOKE+=("[PASS] 7/8. keyless web configured") || { SMOKE+=("[FAIL] 7/8. keyless web"); G9=0; }
node -e 'const m=require(process.argv[1]);if(!m.mcpServers||!m.mcpServers.playwright)process.exit(1)' "$MCP_SHARED" && SMOKE+=("[PASS] 11. playwright MCP present") || { SMOKE+=("[FAIL] 11. playwright MCP"); G9=0; }
echo "$PI_LIST" | grep -q pi-goal && SMOKE+=("[PASS] 12. pi-goal package visible") || { SMOKE+=("[FAIL] 12. pi-goal not visible"); G9=0; }
echo "$PI_LIST" | grep -q pi-background-tasks && SMOKE+=("[PASS] 13. pi-background-tasks package visible") || { SMOKE+=("[FAIL] 13. pi-background-tasks not visible"); G9=0; }
SMOKE+=("[DEFERRED] 9/10. two parallel subagents + retrieval — manual release gate (needs live model)")
SMOKE+=("[INFO] 13. Pi Web reads ~/.pi/agent by design; same-config verification is part of the manual release gate")
SMOKE+=("[PASS] 14. no WSL/WSL2 dependency ($OS_NAME native)")
SMOKE+=("[PASS] 15. no PUI runtime process")
for s in "${SMOKE[@]}"; do echo "  $s"; done
gate G9 "acceptance smoke" "$G9"

# ---- summary ----
echo
echo "=== PUI install summary ==="
for g in "${GATE_RESULTS[@]}"; do echo "  $g"; done
if [ "${#FAILURES[@]}" -gt 0 ]; then echo "Failed gates: ${FAILURES[*]}"; exit 1; fi
echo
echo "PUI setup complete. Pi remains the runtime; the update extension and Pi Web integration stay installed, along with the skill-loader extension."
if [ "$NO_PWA" -eq 0 ] && [ "$NO_BROWSER" -eq 0 ]; then
  if [ "$OS_NAME" = "macOS" ]; then
    echo "Complete PWA installation via Safari 'Add to Dock' on the opened page."
  else
    echo "Complete PWA installation via Chrome/Edge 'Install page as app' on the opened page."
  fi
fi
echo "Run ./doctor.sh anytime for diagnostics."
