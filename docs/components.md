# PUI components

PUI is a composition profile with no separate runtime process, daemon, persistent control directory, retained checkout, or Pi fork. A small installed update extension records the certified PUI version and composition, while an exact-version Pi Web patch provides app-level discovery and explicit update controls.

## Upstream components

| Capability | Package | Configuration | Notes |
|---|---|---|---|
| Agent runtime | `@earendil-works/pi-coding-agent` | Pi settings | Standalone CLI aligned to Pi Web's bundled version |
| GUI | `@agegr/pi-web` | Pi Web build | Loopback `127.0.0.1:30141`; `--no-open` for autostart |
| Subagents | `@gotgenes/pi-subagents` | Pi package entry | In-process subagent extension |
| Web search and fetch | `pi-web-access` | `~/.pi/web-search.json` | Anonymous Exa, DuckDuckGo fallback, direct HTTP fetch |
| MCP adapter | `pi-mcp-adapter` | `~/.config/mcp/mcp.json` | Proxy-first MCP layer with selected direct tools; footer status hidden (`mcpFooterStatus=off`) |
| Browser automation | `@playwright/mcp` | `~/.config/mcp/mcp.json` | Lazy, headless Chrome; `browser_navigate` and five other common tools direct, long tail proxied |
| Goal completion | `@narumitw/pi-goal` | `~/.pi/agent/pi-goal.json` | Session-scoped `/goal` mode; unlimited automatic turns (`automaticTurns=null`) with a readable `Goal: <status> · <reason> · <counter>` status line via a PUI-managed dist patch |
| Account switching | `@narumitw/pi-accounts` | Extension-owned account state | Named subscription OAuth accounts across supported providers |
| Provider usage | `@narumitw/pi-usage` | Pi package entry | `/usage` and `/fast` for current-provider limits and Codex Fast mode |
| Structured questions | `@juicesharp/rpiv-ask-user-question` | Optional extension-owned config | Typed `ask_user_question` choices and free-form answers |
| Fuzzy file navigation | `pi-fff` | Extension-owned feature state | Fuzzy references, path resolution, and indexed content search; startup notices suppressed via PUI-managed feature config |
| Background tasks | `@99percentpeople/pi-background-tasks` | Pi package entry + native dependency | `bg_*` pipe and PTY tasks with attachable output; install/update verifies and can rebuild `node-pty` |
| PUI update identity | PUI-owned `pui-update` extension | `~/.pi/agent/extensions/pui-update/manifest.json` | Inert unless invoked; no polling or daemon |

## Managed files and fields

PUI structurally merges the configuration JSON files below after making timestamped backups. The native recovery path also backs up `~/.pi/agent/npm/package.json` before asking npm to record its exact `node-pty` script approval:

- `~/.pi/agent/settings.json`: `defaultTools` and managed package entries
- `~/.pi/web-search.json`: `searchRouting`, `fetchRouting`, and `workflow`
- `~/.config/mcp/mcp.json`: `mcpServers.playwright.command`, `args`, the six-tool `directTools` policy, and `settings.mcpFooterStatus`
- `~/.pi/agent/pi-goal.json`: `continuationLimits.automaticTurns` and `continuationLimits.noProgressTurns`
- `~/.pi/agent/npm/package.json`: only the exact `node-pty` lifecycle approval when a native rebuild is required
- `~/.pi/agent/extensions/pui-update/`: installed PUI identity and detached transaction worker

PUI owns the exact package pins for its added extensions, but it does not manage their optional configuration, account or feature state, or logs. For `@99percentpeople/pi-background-tasks`, the lifecycle entry points additionally verify that its `node-pty` native binding loads and approve/rebuild that dependency only when the bundled prebuild cannot load. The one exception is `@narumitw/pi-goal`: PUI replaces the installed `formatStatus` bundle with a structured implementation that emits a readable `Goal: <status> · <reason> · <counter>` line (for example `Goal: paused · usage · 0/25`), with the counter omitted entirely when turns are unlimited. The completion path emits `Goal: complete · <elapsed>` before preserving upstream's eight-second status clear. The replacement calls only cross-chunk imported helpers whose names the bundler preserves, never minified same-chunk locals. The patch is version-anchored to the pinned pi-goal release, marked with sentinel comments for idempotency, re-applied by install and update after every `pi install @narumitw/pi-goal`, and fails fast when its function boundaries drift so a version bump surfaces loudly instead of silently shipping an unpatched status line.

PUI's MCP policy is proxy-first: servers stay available through the `mcp` tool, and only frequently used operations are promoted through a server's `directTools` list. PUI does not set `settings.disableProxyTool`, overwrite global adapter settings, or apply its Playwright policy to unrelated MCP servers.

It may also write one per-user autostart file:

- Windows: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\pui-piweb.vbs`
- macOS: `~/Library/LaunchAgents/com.pui.piweb.plist`
- Linux: `~/.config/systemd/user/pui-piweb.service`

The branding helper patches only Pi Web's top-level title, description, sidebar brand, manifest, favicon, Apple touch icon, and PWA icon metadata. Component-name occurrences such as release text remain “Pi Web.” It also shrinks the footer widget-trigger cell from its fixed 70% shelf basis to content width (keeping the 70% cap and horizontal scroll) so a single extension widget does not leave a large empty gap next to the status text, and drops the now-adjacent duplicate right border on the last trigger. Original build files are stored as `*.pui-original`, the service-worker cache name receives a PUI suffix, update reapplies the override, and uninstall restores the originals.

The update integration is pinned to the exact Pi Web version in `stack.json`. It replaces the existing `/api/app-update` implementation through a narrow expected-pattern check and injects one public client script into the prerendered app document. Its separate ownership manifest and backups allow uninstall to restore it only while the complete installed shape still matches PUI.

The injected client renders the update notification card and an always-visible Restart PUI control (reusing the card styling, positioned below the notification). Restart sends `PUT /api/app-update`; the bridge rejects the request with HTTP 409 while an update or restart is already in progress, marks the status as restarting, then spawns a detached restarter that stops the managed Pi Web processes and relaunches Pi Web through the same launcher as autostart (the hidden Startup-folder VBS on Windows, `launchctl kickstart -k` on macOS, `systemctl --user restart` on Linux, falling back to a detached `pi-web --no-open` when no managed autostart exists). The restarter writes progress to the update status file and only reports success after Pi Web answers HTTP again. The client shows the restart phases on the card: on success the page reloads (returning an active Restart control); on failure the card reports the error and the button is re-enabled. The restarter runs from the installed `updater.js` and never goes through the update transaction's idle gate.

Autostart suppresses Pi Web's npm updater because PUI owns the complete pinned composition. The PUI card checks the latest stable GitHub release once per app launch. After explicit approval, a detached worker stages tagged snapshots in OS temporary storage, waits for managed work to become idle, applies the target, and rolls back to the previous manifest-defined composition on failure. Transaction status is temporary and survives only long enough for the app to report the result.

## Files PUI does not manage

- `~/.pi/agent/sessions/`: user session data
- `~/.pi/agent/models.json`: model and provider configuration
- `~/.pi/agent/auth/`: credentials
- Project `AGENTS.md`, `CLAUDE.md`, and `.pi/settings.json` files outside this repository
- Host-specific MCP configuration for other applications

## Repository layout

```text
PUI/
|-- AGENTS.md, CLAUDE.md       repository instructions
|-- README.md                  user guide
|-- stack.json                 managed package and configuration metadata
|-- package.json               test commands
|-- assets/icons/              committed browser, PWA, and Apple icons
|-- assets/pui-update-client.js update-card client
|-- extensions/pui-update/     installed extension source
|-- lib/
|   |-- pui-config.js          structural JSON merge helper
|   |-- pui-stack.js           stack value reader for shell scripts
|   |-- pui-branding.js        Pi Web text, metadata, and footer-layout override
|   |-- pui-icons.js           icon installer and restorer
|   |-- pui-release.js         exact release and checkpoint validation
|   |-- pui-updater.js         shared transaction and rollback worker
|   |-- pui-update-extension.js installed identity ownership helper
|   |-- pui-web-integration.js exact Pi Web bridge patch helper
|   |-- pui-native-check.js    node-pty verification and rebuild helper
|   `-- recolor-icons.cjs      icon regeneration utility
|-- install.*, update.*        setup and update entry points
|-- doctor.*, uninstall.*      diagnostics and removal entry points
|-- tests/                     Node test suites
|-- docs/                      platform and verification references
`-- .github/workflows/         static and integration checks
```

The `.sh` scripts share behavior across macOS and Linux except for LaunchAgent and systemd integration. PowerShell provides the matching Windows workflow.

## Validation

Run the complete Node suite with:

```bash
npm test
```

CI also parses every PowerShell script, runs `bash -n` on every shell entry point on macOS and Linux, and executes a scheduled clean Linux installation twice to check idempotency. Manual checks that require a live model, upstream service, or desktop browser are recorded in [upstream-verification.md](upstream-verification.md).

## Minimum Node.js version

`stack.json` defines `minimumNode` as `22.19.0`, matching Pi Web's documented minimum. Update the field and user documentation together if upstream changes that requirement.
