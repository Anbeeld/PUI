# PUI components

PUI is a composition profile with no separate runtime process, daemon, persistent control directory, retained checkout, or Pi fork. A small installed update extension records the certified PUI version and composition, while an exact-version Pi Web patch provides app-level discovery and explicit update controls.

PUI-managed configuration, build overrides, and patch ownership are documented in [patches.md](patches.md).

## Upstream components

| Capability | Package | Configuration | Notes |
|---|---|---|---|
| Agent runtime | `@earendil-works/pi-coding-agent` | Pi settings | Standalone CLI aligned to Pi Web's bundled version |
| GUI | `@agegr/pi-web` | Pi Web build | Loopback `127.0.0.1:30141`; `--no-open` for autostart |
| Subagents | `@gotgenes/pi-subagents` | Pi package entry + PUI-owned source patch + user mapping config | Parallel-only default delegation with background `Worker`, local read-only `Explore`, and external read-only `Research`; profile tools and readable inputs are checked before spawn/resume, narrow questions are bounded, and sole-critical-path follow-ups stay in main; built-in children retain authority/project instructions without parent-only capability metadata or duplicate skills and fail early on inaccessible evidence or execution; fail-closed routing, 128 running/512 queued agents, completion delivery, model mapping, and reasoning inheritance |
| Web search and fetch | `pi-web-access` | `~/.pi/web-search.json` | Anonymous Exa, DuckDuckGo fallback, direct HTTP fetch |
| MCP adapter | `pi-mcp-adapter` | `~/.config/mcp/mcp.json` | Proxy-first MCP layer with selected direct tools; footer status hidden (`mcpFooterStatus=off`) |
| Browser automation | `@playwright/mcp` | `~/.config/mcp/mcp.json` | Lazy, headless Chrome; `browser_navigate` and five other common tools direct, long tail proxied |
| Goal completion | `@narumitw/pi-goal` | `~/.pi/agent/pi-goal.json` | Session-scoped `/goal` mode; unlimited automatic turns (`automaticTurns=null`), readable status, durable user-visible completion, and compaction-style completion-body typography via PUI-managed exact-version patches |
| Account switching | `@narumitw/pi-accounts` | Extension-owned account state | Named subscription OAuth accounts across supported providers |
| Provider usage | `@narumitw/pi-usage` | Pi package entry | `/usage` and `/fast` for current-provider limits and Codex Fast mode |
| Structured questions | `@juicesharp/rpiv-ask-user-question` | `~/.config/rpiv-ask-user-question/config.json` | Typed choices, free-form answers, and compact PUI-managed model guidance |
| Fuzzy file navigation | `pi-fff` | Extension-owned feature state | Fuzzy references, path resolution, and indexed content search; startup notices and custom agent tools suppressed via PUI-managed feature config |
| Background tasks | `@99percentpeople/pi-background-tasks` | Pi package entry + PUI-owned prompt patch + native dependency | `bg_*` pipe and PTY tasks with compact model guidance; install/update verifies and can rebuild `node-pty` |
| PUI update identity | PUI-owned `pui-update` extension | `~/.pi/agent/extensions/pui-update/manifest.json` | Inert unless invoked; no polling or daemon |

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
|   |-- pui-background-tasks-patch.js compact model-guidance patch and restore helper
|   |-- pui-subagents-patch.js taxonomy/routing/capability/model/reasoning/completion policy helper
|   |-- pui-pi-8782-backport.js temporary Pi #8782 Pi Web runtime patch and restore helper
|   |-- pui-reasoning-summary-patch.js Responses summary display patch and ownership helper
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
