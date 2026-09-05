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

# 1. remove PUI-created autostart — OS-specific. Compare the complete canonical
# shape first: a same-named file with user edits is preserved.
PIWEB_BIN="$(command -v pi-web 2>/dev/null || true)"
PIWEB_PATH="$(dirname "$PIWEB_BIN"):${PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
if [ "$OS_NAME" = "macOS" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.pui.piweb.plist"
  if [ -f "$PLIST" ] && [ -n "$PIWEB_BIN" ] && cmp -s "$PLIST" <(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pui.piweb</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PIWEB_BIN</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PI_WEB_SKIP_VERSION_CHECK</key><string>1</string>
    <key>PATH</key><string>$PIWEB_PATH</string>
  </dict>
</dict>
</plist>
EOF
); then
    echo "  removing canonical LaunchAgent com.pui.piweb..."
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
  elif [ -f "$PLIST" ]; then
    echo "  LaunchAgent com.pui.piweb differs from the complete canonical shape; preserving (user-owned)." >&2
  else
    echo "  no com.pui.piweb LaunchAgent found"
  fi
elif [ "$OS_NAME" = "Linux" ]; then
  SERVICE_FILE="$HOME/.config/systemd/user/pui-piweb.service"
  if [ -f "$SERVICE_FILE" ] && [ -n "$PIWEB_BIN" ] && cmp -s "$SERVICE_FILE" <(cat <<EOF
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
); then
    echo "  removing canonical systemd user service pui-piweb..."
    systemctl --user stop pui-piweb 2>/dev/null || true
    systemctl --user disable pui-piweb 2>/dev/null || true
    rm -f "$SERVICE_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
  elif [ -f "$SERVICE_FILE" ]; then
    echo "  systemd user service pui-piweb differs from the complete canonical shape; preserving (user-owned)." >&2
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
    node "$LIB" backup "$MCP_SHARED" >/dev/null || { echo "  MCP config backup failed; uninstall aborted" >&2; exit 1; }
    node "$LIB" remove-server "$MCP_SHARED" playwright >/dev/null
  else
    echo "  'playwright' MCP entry differs from PUI-managed shape; preserving (user-owned)."
  fi
fi

ASK_GUIDANCE="$(node -e 'const s=require(process.argv[1]);process.stdout.write(JSON.stringify(s.askUserQuestion.guidance))' "$STACK")"
while IFS= read -r ASK_USER_CONFIG; do
  [ -f "$ASK_USER_CONFIG" ] || continue
  set +e
  node "$LIB" remove-owned-fields "$ASK_USER_CONFIG" guidance "$ASK_GUIDANCE" >/dev/null 2>&1
  ASK_REMOVE_EXIT=$?
  set -e
  if [ "$ASK_REMOVE_EXIT" -eq 0 ]; then
    echo "  backed up and removed PUI-managed ask-user-question guidance from $ASK_USER_CONFIG"
  elif [ "$ASK_REMOVE_EXIT" -eq 2 ]; then
    echo "  ask-user-question guidance differs from the PUI-managed shape; preserving (user-owned)."
  else
    echo "  could not inspect ask-user-question guidance; preserving $ASK_USER_CONFIG." >&2
  fi
done < <(node "$LIB" config-candidate-paths "$(jget configPaths.askUserQuestion)" "$(jget askUserQuestion.configRelativePath)")

# Restore original pi-web files (undo PUI branding/icon overrides).
if command -v npm >/dev/null 2>&1; then
  GLOBAL_ROOT="$(npm root -g 2>/dev/null)" || true
  PIWEB_ROOT="${GLOBAL_ROOT}/@agegr/pi-web"
  PI_STANDALONE_ROOT="${GLOBAL_ROOT}/@earendil-works/pi-coding-agent"
  node "$SCRIPT_DIR/lib/pui-reasoning-summary-patch.js" remove "$PIWEB_ROOT" "$PI_STANDALONE_ROOT" "$SCRIPT_DIR" >/dev/null || echo "  reasoning-summary patch differs from its owned shape; preserving."
  if [ -d "$PIWEB_ROOT" ]; then
    node "$SCRIPT_DIR/lib/pui-pi-8782-backport.js" remove "$PIWEB_ROOT" >/dev/null || echo "  Pi #8782 backport differs from its owned shape; preserving."
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
if node "$SCRIPT_DIR/lib/pui-background-tasks-patch.js" remove >/dev/null 2>&1; then
  echo "  removed the PUI-owned pi-background-tasks compatibility patch when present"
else
  echo "  pi-background-tasks compatibility patch differs from its PUI-owned shape; preserving."
fi
if node "$SCRIPT_DIR/lib/pui-subagents-patch.js" remove >/dev/null 2>&1; then
  echo "  removed the PUI-owned pi-subagents policy patch when present"
else
  echo "  pi-subagents policy patch differs from its PUI-owned shape; preserving."
fi
node "$SCRIPT_DIR/lib/pui-update-extension.js" remove "$SCRIPT_DIR" >/dev/null || echo "  PUI update extension differs from its owned shape; preserving."
node "$SCRIPT_DIR/lib/pui-skill-loader-extension.js" remove "$SCRIPT_DIR" >/dev/null || echo "  PUI skill loader extension differs from its owned shape; preserving."
node "$SCRIPT_DIR/lib/pui-reasoning-summary-extension.js" remove "$SCRIPT_DIR" >/dev/null || echo "  PUI reasoning-summary extension differs from its owned shape; preserving."
node "$SCRIPT_DIR/lib/pui-session-title-extension.js" remove "$SCRIPT_DIR" >/dev/null || echo "  PUI session-title extension differs from its owned shape; preserving."

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
