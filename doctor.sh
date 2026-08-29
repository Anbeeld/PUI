#!/usr/bin/env bash
# PUI diagnostics for native macOS and Linux. Reports facts; does not mutate by default.
set -uo pipefail
if [ "$#" -gt 0 ]; then echo "Unknown argument: $1" >&2; exit 64; fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/pui-config.js"
STACK="$SCRIPT_DIR/stack.json"
STACK_READER="$SCRIPT_DIR/lib/pui-stack.js"
expand_path() { echo "${1/#\~/$HOME}"; }
jget() { node "$STACK_READER" "$STACK" "$1"; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }
status_line() { printf "  %-30s %-22s %s\n" "$1" "$2" "$3"; [ "$2" = "FAIL" ] && FAILS=$((FAILS+1)); return 0; }
# Exit 0 when node version string $1 >= semver $2.
node_version_ok() {
  node -e 'const a=process.argv[1].replace(/^v/,"").split(".").map(Number);const b=process.argv[2].split(".").map(Number);for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))process.exit((a[i]||0)>(b[i]||0)?0:1)}process.exit(0)' "$1" "$2"
}

FAILS=0
MIN_NODE="$(jget minimumNode)"
PIWEB_URL="$(jget piWeb.url)"
PIWEB_ROOT="$(npm root -g 2>/dev/null)/@agegr/pi-web"

# ---- OS detection ----
OS_TYPE="$(uname -s)"
case "$OS_TYPE" in
  Darwin) OS_NAME="macOS"; OS_PRETTY="$(sw_vers -productName) $(sw_vers -productVersion 2>/dev/null || echo Darwin)" ;;
  Linux)  OS_NAME="Linux";  OS_PRETTY="Linux $(cut -d= -f2 /etc/os-release 2>/dev/null | head -1 || echo unknown)" ;;
  *) OS_NAME="unknown"; OS_PRETTY="$OS_TYPE" ;;
esac

echo "=== PUI doctor ($OS_NAME) ==="
status_line "OS" "PASS" "$OS_PRETTY"

if has_cmd node; then
  if node_version_ok "$(node --version)" "$MIN_NODE"; then status_line "Node" "PASS" "$(node --version)"
  else status_line "Node" "FAIL" "$(node --version) (min $MIN_NODE)"; fi
else
  status_line "Node" "FAIL" "not found"
fi
has_cmd npm && status_line "npm" "PASS" "$(npm --version)" || status_line "npm" "FAIL" "absent"
has_cmd git && status_line "Git" "PASS" "$(git --version)" || status_line "Git" "FAIL" "absent"

has_cmd pi && status_line "Pi version" "PASS" "$(pi --version 2>/dev/null)" || status_line "Pi version" "FAIL" "pi not on PATH"
if has_cmd pi-web; then
  GLOBAL_ROOT="$(npm root -g)"
  PIWEB_PKG="$GLOBAL_ROOT/@agegr/pi-web/package.json"
  PIWEB_VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "$PIWEB_PKG" 2>/dev/null || true)"
  [ "$PIWEB_VERSION" = "$(jget upstream.gui.version)" ] && status_line "Pi Web version" "PASS" "$PIWEB_VERSION" || status_line "Pi Web version" "FAIL" "$PIWEB_VERSION expected $(jget upstream.gui.version)"
  PW_CA="$(node -e 'const p=require(process.argv[1]);const d=p.dependencies&&p.dependencies["@earendil-works/pi-coding-agent"];if(d)process.stdout.write(d.replace(/[^0-9.]/g,""))' "$PIWEB_PKG" 2>/dev/null)"
  status_line "Pi Web-resolved Pi" "PASS" "$PW_CA"
  PI_VER="$(pi --version 2>/dev/null | sed 's/[^0-9.]//g')"
  [ "$PI_VER" = "$(jget upstream.agentRuntime.version)" ] && [ "$PW_CA" = "$(jget upstream.agentRuntime.version)" ] && status_line "runtime parity" "PASS" "$PI_VER" || status_line "runtime parity" "FAIL" "pi=$PI_VER piweb=$PW_CA expected=$(jget upstream.agentRuntime.version)"
else
  status_line "Pi Web version" "FAIL" "not on PATH"
fi
# Temporary Pi #8782 runtime backport used by Pi Web.
if node "$SCRIPT_DIR/lib/pui-pi-8782-backport.js" verify "$SCRIPT_DIR" "$PIWEB_ROOT" >/dev/null 2>&1; then
  status_line "Pi #8782 backport" "PASS" "Pi Web runtime $(jget upstream.agentRuntime.version) patched"
else
  status_line "Pi #8782 backport" "FAIL" "missing or drifted"
fi

PI_AGENT_DIR="$(expand_path "$(jget configPaths.piAgentDir)")"
PUI_SUBAGENTS_CONFIG="$(expand_path "$(jget configPaths.puiSubagents)")"
PI_SETTINGS="$(expand_path "$(jget configPaths.piSettings)")"
PI_WEB_ACCESS="$(expand_path "$(jget configPaths.piWebAccess)")"
MCP_SHARED="$(expand_path "$(jget configPaths.mcpShared)")"

pi list 2>&1 | grep -q pi-subagents && status_line "package: pi-subagents" "PASS" "" || status_line "package: pi-subagents" "FAIL" ""
pi list 2>&1 | grep -q pi-web-access && status_line "package: pi-web-access" "PASS" "" || status_line "package: pi-web-access" "FAIL" ""
pi list 2>&1 | grep -q pi-mcp-adapter && status_line "package: pi-mcp-adapter" "PASS" "" || status_line "package: pi-mcp-adapter" "FAIL" ""
pi list 2>&1 | grep -q pi-goal && status_line "package: pi-goal" "PASS" "" || status_line "package: pi-goal" "FAIL" ""
pi list 2>&1 | grep -q pi-accounts && status_line "package: pi-accounts" "PASS" "" || status_line "package: pi-accounts" "FAIL" ""
pi list 2>&1 | grep -q pi-usage && status_line "package: pi-usage" "PASS" "" || status_line "package: pi-usage" "FAIL" ""
pi list 2>&1 | grep -q rpiv-ask-user-question && status_line "package: rpiv-ask-user-question" "PASS" "" || status_line "package: rpiv-ask-user-question" "FAIL" ""
pi list 2>&1 | grep -q pi-fff && status_line "package: pi-fff" "PASS" "" || status_line "package: pi-fff" "FAIL" ""
pi list 2>&1 | grep -q pi-background-tasks && status_line "package: pi-background-tasks" "PASS" "" || status_line "package: pi-background-tasks" "FAIL" ""

ASK_USER_CONFIG="$(node "$LIB" resolve-config-path "$(jget configPaths.askUserQuestion)" "$(jget askUserQuestion.configRelativePath)")"
ASK_GUIDANCE="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.askUserQuestion.guidance))' "$STACK")"
if node "$LIB" verify-owned-fields "$ASK_USER_CONFIG" guidance "$ASK_GUIDANCE" >/dev/null 2>&1; then
  status_line "ask-user-question guidance" "PASS" "$ASK_USER_CONFIG"
else
  status_line "ask-user-question guidance" "FAIL" "missing or mismatched: $ASK_USER_CONFIG"
fi

PI_FFF_FEATURES="$(expand_path "$(jget configPaths.piFffFeatures)")"
[ -f "$PI_FFF_FEATURES" ] && node -e 'const f=require(process.argv[1]),s=require(process.argv[2]),r=s.fff.retiredFeatures||[];if(!Array.isArray(f.enabledFeatures)||!s.fff.enabledFeatures.every(x=>f.enabledFeatures.includes(x))||r.some(x=>f.enabledFeatures.includes(x)))process.exit(1)' "$PI_FFF_FEATURES" "$STACK" && status_line "fff feature state" "PASS" "startup notices and custom agent tools disabled" || status_line "fff feature state" "WARN" "missing or incomplete"

# pi-goal unlimited-turn configuration + status patch
PI_GOAL="$(expand_path "$(jget configPaths.piGoal)")"
if [ -f "$PI_GOAL" ]; then
  node -e 'const g=require(process.argv[1]);process.exit(g.continuationLimits&&g.continuationLimits.automaticTurns===null?0:1)' "$PI_GOAL" 2>/dev/null && status_line "pi-goal unlimited turns" "PASS" "automaticTurns=null" || status_line "pi-goal unlimited turns" "WARN" "automaticTurns not null"
else
  status_line "pi-goal unlimited turns" "WARN" "pi-goal.json missing"
fi
if node "$SCRIPT_DIR/lib/pui-goal-patch.js" verify >/dev/null 2>&1; then
  status_line "pi-goal status patch" "PASS" "formatStatus null branch hidden"
else
  status_line "pi-goal status patch" "WARN" "patch not applied (version drift)"
fi

[ -f "$PI_SETTINGS" ] && node -e 'const s=require(process.argv[1]);const r=["read","bash","edit","write","grep","find","ls"];for(const t of r)if(!Array.isArray(s.defaultTools)||s.defaultTools.indexOf(t)<0)process.exit(1)' "$PI_SETTINGS" && status_line "default tool set" "PASS" "" || status_line "default tool set" "WARN" "missing"
for spec in $(node -e 'const s=require(process.argv[1]);for(const p of s.piPackages)console.log(p)' "$STACK"); do
  node -e 'const s=require(process.argv[1]);process.exit(Array.isArray(s.packages)&&s.packages.includes(process.argv[2])?0:1)' "$PI_SETTINGS" "$spec" 2>/dev/null && status_line "managed pin: $spec" "PASS" "" || status_line "managed pin: $spec" "FAIL" ""
done
[ -f "$PI_WEB_ACCESS" ] && node -e 'const w=require(process.argv[1]);if(w.searchRouting.providers.indexOf("duckduckgo")<0||w.fetchRouting.allowRemoteHostedProviders!==false)process.exit(1)' "$PI_WEB_ACCESS" && status_line "web routing" "PASS" "duckduckgo+http" || status_line "web routing" "WARN" "missing"
[ -f "$MCP_SHARED" ] && node -e 'const m=require(process.argv[1]),s=require(process.argv[2]);const p=m.mcpServers&&m.mcpServers.playwright;process.exit(p&&JSON.stringify(p.args)===JSON.stringify(s.mcp.args)&&JSON.stringify(p.directTools)===JSON.stringify(s.mcp.directTools)&&m.settings?.disableProxyTool!==true?0:1)' "$MCP_SHARED" "$STACK" && status_line "Playwright MCP" "PASS" "exact version; 6 direct tools; proxy preserved" || status_line "Playwright MCP" "FAIL" "missing, mismatched, or proxy disabled"
if [ -f "$MCP_SHARED" ]; then
  node -e 'const m=require(process.argv[1]);process.exit(m.settings&&m.settings.mcpFooterStatus==="off"?0:1)' "$MCP_SHARED" 2>/dev/null && status_line "MCP footer status" "PASS" "mcpFooterStatus=off" || status_line "MCP footer status" "WARN" "footer status visible"
fi

# pi-background-tasks compact model guidance and native node-pty binding
if node "$SCRIPT_DIR/lib/pui-background-tasks-patch.js" verify >/dev/null 2>&1; then
  status_line "pi-background-tasks prompt" "PASS" "compact PUI guidance"
else
  status_line "pi-background-tasks prompt" "FAIL" "missing or drifted"
fi
if node "$SCRIPT_DIR/lib/pui-native-check.js" verify "$PI_AGENT_DIR/npm" >/dev/null 2>&1; then
  status_line "pi-background-tasks native" "PASS" "node-pty loads"
else
  status_line "pi-background-tasks native" "FAIL" "node-pty binding missing"
fi
# pi-subagents mapped model and parent reasoning policy
if node "$LIB" validate-model-mappings "$PUI_SUBAGENTS_CONFIG" >/dev/null 2>&1; then
  status_line "subagent model mappings" "PASS" "$PUI_SUBAGENTS_CONFIG"
else
  status_line "subagent model mappings" "FAIL" "missing or invalid: $PUI_SUBAGENTS_CONFIG"
fi
if node "$SCRIPT_DIR/lib/pui-subagents-patch.js" verify >/dev/null 2>&1; then
  status_line "subagent model policy" "PASS" "mapped model and parent reasoning"
else
  status_line "subagent model policy" "FAIL" "missing or drifted"
fi
node "$SCRIPT_DIR/lib/pui-update-extension.js" verify "$SCRIPT_DIR" >/dev/null 2>&1 && status_line "PUI installed identity" "PASS" "extension manifest" || status_line "PUI installed identity" "FAIL" "missing or mismatched"
node "$SCRIPT_DIR/lib/pui-web-integration.js" verify "$SCRIPT_DIR" "$PIWEB_ROOT" >/dev/null 2>&1 && status_line "PUI update bridge" "PASS" "Pi Web $(jget upstream.gui.version)" || status_line "PUI update bridge" "FAIL" "missing or mismatched"

AUTOSTART_REGISTERED=0
if [ "$OS_NAME" = "macOS" ]; then
  PLIST_LABEL="com.pui.piweb"
  if LAUNCH_INFO="$(launchctl print "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null)"; then
    AUTOSTART_REGISTERED=1
    status_line "autostart registration" "PASS" "$PLIST_LABEL loaded"
    if printf '%s\n' "$LAUNCH_INFO" | grep -q "state = running"; then
      status_line "autostart runtime" "PASS" "state=running"
    else
      LAUNCH_STATE="$(printf '%s\n' "$LAUNCH_INFO" | sed -n 's/^[[:space:]]*state = //p' | head -1)"
      LAST_EXIT="$(printf '%s\n' "$LAUNCH_INFO" | sed -n 's/^[[:space:]]*last exit code = //p' | head -1)"
      status_line "autostart runtime" "FAIL" "state=${LAUNCH_STATE:-not running}; last-exit=${LAST_EXIT:-unknown}"
    fi
  else
    status_line "autostart registration" "WARN" "no $PLIST_LABEL"
    status_line "autostart runtime" "NOT CHECKED" "not registered"
  fi
elif [ "$OS_NAME" = "Linux" ]; then
  SERVICE_NAME="pui-piweb"
  if systemctl --user is-enabled "$SERVICE_NAME" >/dev/null 2>&1; then
    AUTOSTART_REGISTERED=1
    status_line "autostart registration" "PASS" "$SERVICE_NAME.service enabled"
    if systemctl --user is-active --quiet "$SERVICE_NAME"; then
      status_line "autostart runtime" "PASS" "active"
    else
      ACTIVE_STATE="$(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || true)"
      status_line "autostart runtime" "FAIL" "${ACTIVE_STATE:-inactive}"
    fi
  else
    status_line "autostart registration" "WARN" "no $SERVICE_NAME.service"
    status_line "autostart runtime" "NOT CHECKED" "not registered"
  fi
else
  status_line "autostart registration" "NOT CHECKED" ""
  status_line "autostart runtime" "NOT CHECKED" ""
fi

if curl -sf --max-time 5 "$PIWEB_URL" >/dev/null 2>&1; then
  status_line "Pi Web health" "PASS" "HTTP 200"
elif [ "$AUTOSTART_REGISTERED" -eq 1 ]; then
  status_line "Pi Web health" "FAIL" "managed service did not answer on $PIWEB_URL"
else
  status_line "Pi Web health" "WARN" "not running on $PIWEB_URL"
fi

status_line "PWA status" "USER ACTION REQUIRED" "verify browser install manually"
if [ "$FAILS" -gt 0 ]; then exit 1; fi
exit 0
