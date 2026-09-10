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

## Session collaboration

Session collaboration is available only through Pi Web. The five tools—`session_list`, `session_get`, `session_send`, `session_start`, and `session_abort`—use the PUI-owned Pi Web 0.8.11 server patch and sidecar. Starts run in the background and queue a completion notification; stopped targets resume. Peer task input is attributed and untrusted, not user authority or approval. `session_get` returns `sessionLogPath`, the persisted JSONL session-log path, without reading the log into context. Model selectors may be exact or fuzzy; model and effort overrides are used only when explicitly requested, with effort rounded down to the nearest supported level. Unrestricted chaining or fan-out can grow without bound.

## Maintenance

```powershell
./update.ps1
./doctor.ps1
./uninstall.ps1
./uninstall.ps1 -Full
```

Update uses the shared transactional worker, waits for managed work to become idle, and restores the previous certified release after a failed mutation. Doctor verifies exact identity and bridge state without writing. Standard uninstall removes only intact PUI-owned integration; `-Full` also removes managed packages, Pi Web, and standalone Pi while preserving user projects, sessions, authentication, skills, and unrelated settings.

See the main [README](../README.md) for install options and ownership details.
