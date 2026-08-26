# PUI on Windows

## Prerequisites

- Windows 10 or 11
- Node.js 22.19.0 or newer (`node --version`)
- npm, which is bundled with Node.js
- Git for Windows

## Install

From this repository in PowerShell:

```powershell
./install.ps1
```

The installer verifies prerequisites, backs up existing configuration, installs the exact versions in `stack.json`, merges PUI-owned configuration, applies branding and the update bridge, installs the PUI identity extension, configures Playwright MCP, and runs smoke checks.

## Autostart and PWA

Unless `-NoPwa` is used, PUI writes `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\pui-piweb.vbs`. The per-user launcher runs `pi-web.cmd --no-open` hidden at login without elevation.

After installation, use the browser's install-app action at `http://127.0.0.1:30141`. The browser requires this manual confirmation.

## Maintenance

```powershell
./update.ps1
./doctor.ps1
./uninstall.ps1
./uninstall.ps1 -Full
```

Update uses the shared transactional worker, waits for managed work to become idle, and restores the previous certified release after a failed mutation. Doctor verifies exact identity and bridge state without writing. Standard uninstall removes only intact PUI-owned integration; `-Full` also removes managed packages, Pi Web, and standalone Pi while preserving user projects, sessions, authentication, skills, and unrelated settings.

See the main [README](../README.md) for install options and ownership details.
