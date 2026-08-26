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

After installation, use Safari's Add to Dock or a Chromium browser's install-app action at `http://127.0.0.1:30141`. The browser requires this manual confirmation.

## Maintenance

```bash
./update.sh
./doctor.sh
./uninstall.sh
./uninstall.sh --full
```

Update uses the shared transactional worker, waits for managed work to become idle, and restores the previous certified release after a failed mutation. Doctor verifies exact identity and bridge state without writing and reports LaunchAgent status separately. Standard uninstall removes only intact PUI-owned integration; `--full` also removes managed packages, Pi Web, and standalone Pi while preserving user projects, sessions, authentication, skills, and unrelated settings.

See the main [README](../README.md) for install options and ownership details.
