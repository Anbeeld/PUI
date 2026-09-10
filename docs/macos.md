# PUI on macOS

## Prerequisites

- macOS on Apple Silicon or Intel
- Node.js 22.19.0 or newer (`node --version`)
- npm, which is bundled with Node.js
- Git

## Install

From this repository in a terminal:

```bash
./install.sh
```

The installer verifies prerequisites, backs up existing configuration, installs the exact versions in `stack.json`, merges PUI-owned configuration, applies branding and the update bridge, installs the PUI identity extension, configures Playwright MCP, and runs smoke checks.

## Autostart and PWA

Unless `--no-pwa` is used, PUI writes the per-user LaunchAgent `~/Library/LaunchAgents/com.pui.piweb.plist`. The LaunchAgent is the only process owner for `pi-web --no-open`; it starts the server when loaded and restarts it after an unsuccessful exit. Root access is not required.

Installation and update wait until `launchctl print gui/$(id -u)/com.pui.piweb` reports `state = running` and `http://127.0.0.1:30141` returns HTTP 200. Either failure stops the lifecycle script instead of accepting an unrelated process on the same port.

Updates stop the LaunchAgent before replacing the global Pi Web package and start it again in the final step. If an update aborts in between, its exit path loads the LaunchAgent (or kickstarts it when the job is still loaded) and waits for HTTP 200, so a failed update does not leave `com.pui.piweb` booted out of the user domain. When Pi Web runs without PUI autostart, the interrupted update relaunches the same `pi-web --no-open` process it stopped.

After installation, use Safari's Add to Dock or a Chromium browser's install-app action at `http://127.0.0.1:30141`. The browser requires this manual confirmation.

## Session collaboration

Session collaboration is available only through Pi Web. The five tools—`session_list`, `session_get`, `session_send`, `session_start`, and `session_abort`—use the PUI-owned Pi Web 0.8.11 server patch and sidecar. Starts run in the background and queue a completion notification; stopped targets resume. Peer task input is attributed and untrusted, not user authority or approval. `session_get` returns `sessionLogPath`, the persisted JSONL session-log path, without reading the log into context. Model selectors may be exact or fuzzy; model and effort overrides are used only when explicitly requested, with effort rounded down to the nearest supported level. Unrestricted chaining or fan-out can grow without bound.

## Maintenance

```bash
./update.sh
./doctor.sh
./uninstall.sh
./uninstall.sh --full
```

Update stage and rollback output is retained at `~/.pi/agent/state/pui-update/last.log` with the newest status at `~/.pi/agent/state/pui-update/last-status.json`.

Update uses the shared transactional worker, waits for managed work to become idle, and restores the previous certified release after a failed mutation. Doctor verifies exact identity and bridge state without writing and reports LaunchAgent status separately. Standard uninstall removes only intact PUI-owned integration; `--full` also removes managed packages, Pi Web, and standalone Pi while preserving user projects, sessions, authentication, skills, and unrelated settings.

See the main [README](../README.md) for install options and ownership details.
