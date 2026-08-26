# PUI components

PUI is a composition profile with no separate runtime process, daemon, persistent control directory, retained checkout, or Pi fork. A small installed update extension records the certified PUI version and composition, while an exact-version Pi Web patch provides app-level discovery and explicit update controls.

## Upstream components

| Capability | Package | Configuration | Notes |
|---|---|---|---|
| Agent runtime | `@earendil-works/pi-coding-agent` | Pi settings | Standalone CLI aligned to Pi Web's bundled version |
| GUI | `@agegr/pi-web` | Pi Web build | Loopback `127.0.0.1:30141`; `--no-open` for autostart |
| Subagents | `@gotgenes/pi-subagents` | Pi package entry | In-process subagent extension |
| Web search and fetch | `pi-web-access` | `~/.pi/web-search.json` | Anonymous Exa, DuckDuckGo fallback, direct HTTP fetch |
| MCP adapter | `pi-mcp-adapter` | `~/.config/mcp/mcp.json` | Lazy MCP proxy |
| Browser automation | `@playwright/mcp` | `~/.config/mcp/mcp.json` | Lazy, headless Chrome server |
| Goal completion | `@narumitw/pi-goal` | Pi package entry | Session-scoped `/goal` mode |
| PUI update identity | PUI-owned `pui-update` extension | `~/.pi/agent/extensions/pui-update/manifest.json` | Inert unless invoked; no polling or daemon |

## Managed files and fields

PUI structurally merges these JSON files after making timestamped backups:

- `~/.pi/agent/settings.json`: `defaultTools` and managed package entries
- `~/.pi/web-search.json`: `searchRouting`, `fetchRouting`, and `workflow`
- `~/.config/mcp/mcp.json`: `mcpServers.playwright`
- `~/.pi/agent/extensions/pui-update/`: installed PUI identity and detached transaction worker

It may also write one per-user autostart file:

- Windows: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\pui-piweb.vbs`
- macOS: `~/Library/LaunchAgents/com.pui.piweb.plist`
- Linux: `~/.config/systemd/user/pui-piweb.service`

The branding helper patches only Pi Web's top-level title, description, sidebar brand, manifest, favicon, Apple touch icon, and PWA icon metadata. Component-name occurrences such as release text remain “Pi Web.” Original build files are stored as `*.pui-original`, the service-worker cache name receives a PUI suffix, update reapplies the override, and uninstall restores the originals.

The update integration is pinned to the exact Pi Web version in `stack.json`. It replaces the existing `/api/app-update` implementation through a narrow expected-pattern check and injects one public client script into the prerendered app document. Its separate ownership manifest and backups allow uninstall to restore it only while the complete installed shape still matches PUI.

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
|   |-- pui-branding.js        Pi Web text and metadata override
|   |-- pui-icons.js           icon installer and restorer
|   |-- pui-release.js         exact release and checkpoint validation
|   |-- pui-updater.js         shared transaction and rollback worker
|   |-- pui-update-extension.js installed identity ownership helper
|   |-- pui-web-integration.js exact Pi Web bridge patch helper
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
