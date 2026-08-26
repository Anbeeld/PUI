#!/usr/bin/env bash
# PUI uninstaller for native macOS and Linux. Removes only PUI-added integration by default.
# Preserves user projects, sessions, model auth, AGENTS.md, skills, prompts, themes,
# and unrelated Pi configuration. Leaves Pi and Pi Web installed unless --full is given.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/pui-config.js"
STACK="$SCRIPT_DIR/stack.json"
STACK_READER="$SCRIPT_DIR/lib/pui-stack.js"
expand_path() { echo "${1/#\~/$HOME}"; }
jget() { node "$STACK_READER" "$STACK" "$1"; }
FULL=0
for arg in "$@"; do case "$arg" in --full) FULL=1 ;; *) echo "Unknown: $arg"; exit 64 ;; esac; done

# ---- OS detection ----
OS_TYPE="$(uname -s)"
case "$OS_TYPE" in
  Darwin) OS_NAME="macOS" ;;
  Linux)  OS_NAME="Linux" ;;
  *) echo "Unsupported OS: $OS_TYPE"; exit 1 ;;
esac

echo "=== PUI uninstall ($OS_NAME) ==="

# 1. remove PUI-created autostart — OS-specific.
if [ "$OS_NAME" = "macOS" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.pui.piweb.plist"
  if [ -f "$PLIST" ]; then
    echo "  removing LaunchAgent com.pui.piweb..."
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
  else
    echo "  no com.pui.piweb LaunchAgent found"
  fi
elif [ "$OS_NAME" = "Linux" ]; then
  SERVICE_FILE="$HOME/.config/systemd/user/pui-piweb.service"
  if [ -f "$SERVICE_FILE" ]; then
    echo "  removing systemd user service pui-piweb..."
    systemctl --user stop pui-piweb 2>/dev/null || true
    systemctl --user disable pui-piweb 2>/dev/null || true
    rm -f "$SERVICE_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
  else
    echo "  no pui-piweb.service found"
  fi
fi

echo "  PWA browser app: remove manually from browser settings if installed."

MCP_SHARED="$(expand_path "$(jget configPaths.mcpShared)")"
if [ -f "$MCP_SHARED" ]; then
  # Exact-shape ownership check: command, args, lifecycle, and direct tools must equal the
  # PUI-managed definition; anything else is user-owned and preserved.
  if node -e '
const s=require(process.argv[1]);
const m=require(process.argv[2]);
const p=m.mcpServers&&m.mcpServers.playwright;
const ok=p&&p.command===s.mcp.command&&JSON.stringify(p.args||null)===JSON.stringify(s.mcp.args)&&p.lifecycle===s.mcp.lifecycle&&JSON.stringify(p.directTools||null)===JSON.stringify(s.mcp.directTools);
process.exit(ok?0:1)' "$STACK" "$MCP_SHARED" 2>/dev/null; then
    echo "  removing PUI-managed 'playwright' MCP entry from $MCP_SHARED"
    node "$LIB" remove-server "$MCP_SHARED" playwright >/dev/null
  else
    echo "  'playwright' MCP entry differs from PUI-managed shape; preserving (user-owned)."
  fi
fi

# Restore original pi-web files (undo PUI branding/icon overrides).
if command -v npm >/dev/null 2>&1; then
  PIWEB_ROOT="$(npm root -g 2>/dev/null)/@agegr/pi-web" || true
  if [ -d "$PIWEB_ROOT" ]; then
    node "$SCRIPT_DIR/lib/pui-web-integration.js" remove "$SCRIPT_DIR" "$PIWEB_ROOT" >/dev/null || echo "  PUI update integration differs from its owned shape; preserving."
    find "$PIWEB_ROOT" -name "*.pui-created" -type f | while read -r marker; do
      created="${marker%.pui-created}"
      rm -f "$created" "$marker"
      echo "  removed PUI-created asset: $(basename "$created")"
    done
    find "$PIWEB_ROOT" -name "*.pui-original" -type f | while read -r bk; do
      orig="${bk%.pui-original}"
      cp "$bk" "$orig"
      rm -f "$bk"
      echo "  restored original: $(basename "$orig")"
    done
  fi
fi
node "$SCRIPT_DIR/lib/pui-update-extension.js" remove "$SCRIPT_DIR" >/dev/null || echo "  PUI update extension differs from its owned shape; preserving."

if [ "$FULL" -eq 1 ]; then
  echo "  --full: removing PUI-selected Pi packages..."
  for spec in $(node -e 'const s=require(process.argv[1]);for(const p of new Set([...s.piPackages,...(s.retiredPiPackages||[])]))console.log(p.replace(/@\d+\.\d+\.\d+$/,""))' "$STACK"); do
    echo "    pi remove $spec"
    pi remove "$spec" 2>&1 | sed 's/^/      /' || true
  done
  echo "  --full: uninstalling pi-web and pi (npm globals)..."
  npm uninstall -g "@agegr/pi-web" >/dev/null
  npm uninstall -g "@earendil-works/pi-coding-agent" >/dev/null
else
  echo "  Pi packages, pi-web, and pi are left installed (use --full to remove them too)."
fi

echo "  Preserved: ~/.pi/agent (sessions, settings, auth, skills, prompts, themes)."
echo "  Preserved: unrelated MCP servers and pi-web-access settings."
echo "  Preserved: pi and pi-web (unless --full)."
echo
echo "PUI uninstall complete."
