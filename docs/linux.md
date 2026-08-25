# PUI on Linux

## Prerequisites

- Linux
- Node.js 22.19.0 or newer (`node --version`)
- npm, which is bundled with Node.js
- Git
- `curl` for health checks
- systemd only when using the default per-user autostart setup

## Install

From this repository in a terminal:

```bash
./install.sh
```

The shared macOS/Linux installer detects the operating system with `uname -s`. It verifies prerequisites, backs up existing configuration, installs Pi Web and the packages in `stack.json`, aligns standalone Pi to Pi Web's bundled version, merges PUI-owned configuration, applies PUI branding and icons, configures Playwright MCP, and runs smoke checks.

## Autostart and PWA

Unless `--no-pwa` is used, PUI writes `~/.config/systemd/user/pui-piweb.service`, gives it the active Node and Pi Web `PATH`, enables it for `default.target`, and starts it immediately. The systemd user service is the only process owner for `pi-web --no-open` and restarts it after a failure.

Installation and update wait until `systemctl --user is-active pui-piweb` succeeds and `http://127.0.0.1:30141` returns HTTP 200. Either failure stops the lifecycle script instead of accepting an unrelated process on the same port. On distributions that require lingering for user services before login, configure it separately with `loginctl enable-linger` if that behavior is desired.

After installation, use a Chromium browser's install-app action at `http://127.0.0.1:30141`. The browser requires this manual confirmation.

## Maintenance

```bash
./update.sh
./doctor.sh
./uninstall.sh
./uninstall.sh --full
```

Update refreshes the managed components and reapplies branding and icons. Doctor is read-only and reports service enablement, runtime state, and HTTP health separately. Standard uninstall removes PUI-owned integration; `--full` also removes managed packages, Pi Web, and standalone Pi while preserving user projects, sessions, authentication, skills, and unrelated settings.

See the main [README](../README.md) for install options and ownership details.
