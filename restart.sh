#!/usr/bin/env bash
# Restart only the installed Pi Web runtime; do not reconcile packages or config.
set -euo pipefail
if [ "$#" -ne 0 ]; then echo "Usage: $0" >&2; exit 64; fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIWEB_URL="$(node "$SCRIPT_DIR/lib/pui-stack.js" "$SCRIPT_DIR/stack.json" piWeb.url)"
PIWEB_PORT="$(node "$SCRIPT_DIR/lib/pui-stack.js" "$SCRIPT_DIR/stack.json" piWeb.port)"
OS_TYPE="$(uname -s)"
PLIST="$HOME/Library/LaunchAgents/com.pui.piweb.plist"
SERVICE_FILE="$HOME/.config/systemd/user/pui-piweb.service"
MODE=manual
case "$OS_TYPE" in
  Darwin) if [ -f "$PLIST" ]; then MODE=launchd; fi ;;
  Linux) if [ -f "$SERVICE_FILE" ]; then MODE=systemd; fi ;;
  *) echo "Unsupported OS: $OS_TYPE" >&2; exit 1 ;;
esac
command -v curl >/dev/null
if [ "$MODE" = manual ]; then
  PIWEB_BIN="$(command -v pi-web)" || { echo "pi-web is not installed on PATH" >&2; exit 1; }
fi

# Match the same package path / npm shim as install and update. Next.js may
# retitle the server child, so also include the configured port listener.
piweb_pids() {
  { ps -eo pid=,args= | grep -E '[/]node_modules[/]@agegr[/]pi-web[/]|[/]bin[/]pi-web([.]js)?([[:space:]]|$)' | awk '{ print $1 }'; } || true
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:${PIWEB_PORT}" -sTCP:LISTEN 2>/dev/null || true
  fi
}

echo "Restarting PUI (active sessions will be interrupted)..."
# Stop supervision first so it cannot race the explicit shutdown.
case "$MODE" in
  launchd)
    if launchctl print "gui/$(id -u)/com.pui.piweb" >/dev/null 2>&1; then
      launchctl unload "$PLIST"
    fi ;;
  systemd) systemctl --user stop pui-piweb ;;
esac
for pid in $(piweb_pids | sort -u); do kill -KILL "$pid"; done
for _ in $(seq 1 15); do
  [ -z "$(piweb_pids)" ] && break
  sleep 1
done
if [ -n "$(piweb_pids)" ]; then echo "Could not stop Pi Web" >&2; exit 1; fi

case "$MODE" in
  launchd) launchctl load "$PLIST" ;;
  systemd) systemctl --user start pui-piweb ;;
  manual) PI_WEB_SKIP_VERSION_CHECK=1 nohup "$PIWEB_BIN" --no-open >/dev/null 2>&1 < /dev/null & ;;
esac
managed_running() {
  case "$MODE" in
    launchd) launchctl print "gui/$(id -u)/com.pui.piweb" 2>/dev/null | grep -q 'state = running' ;;
    systemd) systemctl --user is-active --quiet pui-piweb ;;
    manual) return 0 ;;
  esac
}
for _ in $(seq 1 30); do
  if managed_running && curl -sf --max-time 5 "$PIWEB_URL" >/dev/null 2>&1; then
    echo "PUI restarted and healthy at $PIWEB_URL"
    exit 0
  fi
  sleep 2
done
echo "Pi Web did not become healthy after restart at $PIWEB_URL" >&2
exit 1
