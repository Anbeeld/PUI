# Upstream verification log

This file records the upstream interfaces and live behaviors that PUI relies on. Recheck them before a release and whenever an upstream major version changes.

## npm registry check (2026-08-25)

All 7 upstream packages exist and publish `latest` distribution tags:

| Package | Latest |
|---|---:|
| `@earendil-works/pi-coding-agent` | 0.84.3 |
| `@agegr/pi-web` | 0.8.9 |
| `@gotgenes/pi-subagents` | 19.3.5 |
| `pi-web-access` | 0.24.2 |
| `pi-mcp-adapter` | 2.27.0 |
| `@playwright/mcp` | 0.0.79 |
| `@narumitw/pi-goal` | 0.54.0 |

PUI uses a rolling release policy. The scripts install current releases and must not rely on these recorded versions as pins.

## Interfaces to recheck

| Assumption | Repository source | Verification method |
|---|---|---|
| Pi settings use `~/.pi/agent/settings.json` | `configPaths.piSettings` | Pi documentation and CLI output |
| `pi-web-access` reads `~/.pi/web-search.json` and supports the configured routing schema and providers | `configPaths.piWebAccess`, `webAccess` | Configuration loader and provider implementations in current source |
| `pi-mcp-adapter` reads `~/.config/mcp/mcp.json` and supports `mcpServers.*.lifecycle` | `configPaths.mcpShared`, `mcp` | Adapter schema and default-path source |
| Pi Web serves loopback port `30141` | `piWeb` | Pi Web documentation and a local health check |
| `pi-web --no-open` suppresses browser launch | `piWeb.noOpenFlag` | `pi-web --help` and a local run |
| `pi update --extensions` and `pi update --models` retain their current semantics | update scripts | `pi update --help` and a test installation |
| `pi install npm:<spec>` remains idempotent | install scripts | Install twice and inspect `settings.json` |
| Installed Pi packages remain represented in `settings.json` `packages[]` | install and pin handling | Inspect settings after `pi install` |
| Pi Web build outputs still contain the targeted branding and icon metadata files | branding and icon helpers | Run helper tests and inspect the installed package |

If an assumption changes, adapt the scripts and tests to the current upstream contract and update this table.

## Manual release checks

These checks require a live model session, upstream service, or desktop browser and are not simulated by the installer:

1. With provider credentials absent, confirm `web_search` returns results through anonymous Exa or DuckDuckGo and `fetch_content` reads a public HTTP(S) page.
2. Spawn two parallel subagents from a parent session and retrieve both completed outputs.
3. Keep one child alive beyond Pi Web's idle threshold to detect detached-child lifetime problems.
4. Navigate to a page through the Playwright MCP adapter.
5. Confirm Pi Web lists the same packages and skills as the CLI.
6. Install and launch the PWA on supported desktop browsers and confirm it uses the same sessions and configuration.

Record the results in the release notes.
