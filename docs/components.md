# PUI components

PUI is a setup-time composition profile. It installs and configures upstream Pi packages without adding a PUI runtime process, configuration hierarchy, or Pi fork. Setup markers, backups, and optional autostart integration remain so updates and uninstall can manage only what PUI owns.

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

## Managed files and fields

PUI structurally merges these JSON files after making timestamped backups:

- `~/.pi/agent/settings.json`: `defaultTools` and managed package entries
- `~/.pi/web-search.json`: `searchRouting`, `fetchRouting`, and `workflow`
- `~/.config/mcp/mcp.json`: `mcpServers.playwright`

It may also write one per-user autostart file:

- Windows: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\pui-piweb.vbs`
- macOS: `~/Library/LaunchAgents/com.pui.piweb.plist`
- Linux: `~/.config/systemd/user/pui-piweb.service`

The branding helper patches only Pi Web's top-level title, description, sidebar brand, manifest, favicon, Apple touch icon, and PWA icon metadata. Component-name occurrences such as release text remain “Pi Web.” Original build files are stored as `*.pui-original`, the service-worker cache name receives a PUI suffix, update reapplies the override, and uninstall restores the originals.

Autostart sets `PI_WEB_SKIP_VERSION_CHECK=1` because PUI's update script owns Pi Web updates. On macOS and Linux, the lifecycle scripts stop the configured service manager before replacing Pi Web, then start it again and require both a running manager state and HTTP 200. They do not launch a second Pi Web process for health checks.

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
|-- lib/
|   |-- pui-config.js          structural JSON merge helper
|   |-- pui-stack.js           stack value reader for shell scripts
|   |-- pui-branding.js        Pi Web text and metadata override
|   |-- pui-icons.js           icon installer and restorer
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
