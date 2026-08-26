# Upstream verification log

This file records the upstream interfaces and live behaviors that PUI relies on. Recheck them before a release and whenever an upstream major version changes.

## npm registry check (2026-08-26)

All 10 upstream packages exist and publish `latest` distribution tags:

| Package | Latest |
|---|---:|
| `@earendil-works/pi-coding-agent` | 0.84.3 |
| `@agegr/pi-web` | 0.8.10 |
| `@gotgenes/pi-subagents` | 19.3.5 |
| `pi-web-access` | 0.25.0 |
| `pi-mcp-adapter` | 2.27.0 |
| `@playwright/mcp` | 0.0.79 |
| `@narumitw/pi-goal` | 0.54.0 |
| `@narumitw/pi-accounts` | 0.49.10 |
| `@juicesharp/rpiv-ask-user-question` | 2.7.1 |
| `pi-fff` | 0.1.12 |

`stack.json` pins these direct managed versions. Release validation rejects ranges, `latest`, and a Playwright MCP command that differs from its exact managed version. Transitive npm dependencies and model-catalog data are not frozen.

## Interfaces to recheck

| Assumption | Repository source | Verification method |
|---|---|---|
| Pi settings use `~/.pi/agent/settings.json` | `configPaths.piSettings` | Pi documentation and CLI output |
| `pi-web-access` reads `~/.pi/web-search.json` and supports the configured routing schema and providers | `configPaths.piWebAccess`, `webAccess` | Configuration loader and provider implementations in current source |
| `pi-mcp-adapter` reads `~/.config/mcp/mcp.json`, supports per-server `directTools`, and leaves omitted tools available through the proxy when `disableProxyTool` is not enabled | `configPaths.mcpShared`, `mcp` | Adapter schema, direct-tool documentation, and default-path source |
| Playwright exposes `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_wait_for`, and `browser_take_screenshot` at version 0.0.79 | `mcp.directTools` | Inspect the pinned package tool catalog and exercise each direct tool |
| Pi Web serves loopback port `30141` | `piWeb` | Pi Web documentation and a local health check |
| `pi-web --no-open` suppresses browser launch | `piWeb.noOpenFlag` | `pi-web --help` and a local run |
| `pi update --models` retains its current model-catalog refresh semantics | update scripts | `pi update --help` and a test installation |
| `pi install npm:<spec>` remains idempotent | install scripts | Install twice and inspect `settings.json` |
| Installed Pi packages remain represented in `settings.json` `packages[]` | install and pin handling | Inspect settings after `pi install` |
| `@narumitw/pi-accounts` switches named accounts without PUI owning extension account state | `piPackages` | Add two test accounts and switch between them in CLI and Pi Web sessions |
| `@juicesharp/rpiv-ask-user-question` registers `ask_user_question` in supported interactive hosts | `piPackages` | Start CLI and Pi Web sessions and complete a structured question |
| `pi-fff` loads its native FFF dependency and indexes the active project on every supported platform | `piPackages` | Run `/fff-status`, fuzzy file resolution, and indexed search on Windows, macOS, and Linux |
| Pi Web build outputs still contain the targeted branding and icon metadata files | branding and icon helpers | Run helper tests and inspect the installed package |
| Pi Web 0.8.10 contains the exact `/api/app-update` route and prerendered app anchors | `pui-web-integration.js` | Run the exact-version integration fixture before release |
| `/api/agent/running` reports aggregate running Pi Web sessions | updater idle gate | Keep a session streaming, compacting, or running bash and inspect the endpoint |

If an assumption changes, adapt the scripts and tests to the current upstream contract and update this table.

## Manual release checks

These checks require a live model session, upstream service, or desktop browser and are not simulated by the installer:

1. With provider credentials absent, confirm `web_search` returns results through anonymous Exa or DuckDuckGo and `fetch_content` reads a public HTTP(S) page.
2. Spawn two parallel subagents from a parent session and retrieve both completed outputs.
3. Keep one child alive beyond Pi Web's idle threshold to detect detached-child lifetime problems.
4. Navigate to a page through the Playwright MCP adapter.
5. Confirm Pi Web lists the same packages and skills as the CLI.
6. Install and launch the PWA on supported desktop browsers and confirm it uses the same sessions and configuration.
7. Complete a structured `ask_user_question` flow in both the terminal and Pi Web.
8. Run `/fff-status`, fuzzy path resolution, and indexed content search on each supported platform.
9. Confirm the six managed Playwright tools register directly while a non-direct tool remains discoverable and callable through the `mcp` proxy.
10. Add two supported OAuth accounts with `pi-accounts` and switch between them in both the terminal and Pi Web.

Record the results in the release notes.

### v1.0.4 functional results (2026-08-26)

Manual v1.0.4 checks for structured questions, fuzzy file search, and the hybrid direct/proxy Playwright surface passed.
