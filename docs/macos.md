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

The installer verifies prerequisites, backs up existing configuration, installs Pi Web and the packages in `stack.json`, aligns standalone Pi to Pi Web's bundled version, merges PUI-owned configuration, applies PUI branding and icons, configures Playwright MCP, and runs smoke checks.

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

Update refreshes the managed components and reapplies branding and icons. Doctor is read-only and reports LaunchAgent registration, runtime state, and HTTP health separately. Standard uninstall removes PUI-owned integration; `--full` also removes managed packages, Pi Web, and standalone Pi while preserving user projects, sessions, authentication, skills, and unrelated settings.

See the main [README](../README.md) for install options and ownership details.
