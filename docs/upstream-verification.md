# Upstream verification log

This file records the upstream interfaces and live behaviors that PUI relies on. Recheck them before a release and whenever an upstream major version changes.

## npm registry check (2026-08-27)

All 12 upstream packages exist and publish `latest` distribution tags:

| Package | Latest |
|---|---:|
| `@earendil-works/pi-coding-agent` | 0.84.3 |
| `@agegr/pi-web` | 0.8.11 |
| `@gotgenes/pi-subagents` | 19.3.5 |
| `pi-web-access` | 0.25.0 |
| `pi-mcp-adapter` | 2.29.0 |
| `@playwright/mcp` | 0.0.79 |
| `@narumitw/pi-goal` | 0.54.3 |
| `@narumitw/pi-accounts` | 0.49.11 |
| `@narumitw/pi-usage` | 0.52.3 |
| `@juicesharp/rpiv-ask-user-question` | 2.7.1 |
| `pi-fff` | 0.1.12 |
| `@99percentpeople/pi-background-tasks` | 2.1.1 |

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
| `@narumitw/pi-usage` reports current-account usage and limits for the active provider and toggles Codex Fast mode without PUI owning extension state | `piPackages` | Run `/usage` for the active provider and toggle `/fast` for a supported Codex model in CLI and Pi Web sessions |
| `@juicesharp/rpiv-ask-user-question` registers `ask_user_question`, loads the existing absolute XDG config before the legacy fallback, and replaces all three configured guidance fields | `piPackages`, `askUserQuestion`, `configPaths.askUserQuestion` | Inspect the pinned config loader, then start CLI and Pi Web sessions and complete a structured question |
| `pi-fff` loads its native FFF dependency and indexes the active project on every supported platform | `piPackages` | Run `/fff-status`, fuzzy file resolution, and indexed search on Windows, macOS, and Linux |
| `@narumitw/pi-goal` exposes elapsed goal time and clears its completion status after the upstream eight-second timer | `piPackages`, `lib/pui-goal-patch.js` | Inspect the exact pinned runtime completion path and run the patch regression test |
| `@99percentpeople/pi-background-tasks` retains the exact 2.1.1 tool metadata anchors patched by PUI, loads `node-pty` from bundled prebuilt binaries on every supported platform, and permits PUI to approve/rebuild its lifecycle scripts when a prebuild is unavailable | `piPackages`, `backgroundTasksPromptPatch`, `lib/pui-background-tasks-patch.js`, `lib/pui-native-check.js` | Run `npm run release:verify-prompt-patches` against the exact published artifact, then run the owned-transform migration/rollback tests against the pinned bundle; run the PUI install/update entry point on Windows, macOS, and Linux (x64/arm64); verify both helpers afterward and confirm a PTY spawns |
| `@gotgenes/pi-subagents` retains the exact 19.3.5 patch anchors and uses PUI's configurable invocation policy: fuzzy mappings come from `~/.config/pui/subagents.json`, omitted `thinking` inherits the parent's active level, and explicit invocation overrides win over mapping and inheritance | `piPackages`, `subagents`, `subagentsPromptPatch`, `configPaths.puiSubagents`, `lib/pui-subagents-patch.js` | Run `npm run release:verify-prompt-patches` against the exact published artifact; its runtime harness exercises fuzzy mapped, explicit, unavailable-model, and missing-registry paths. Run config reconciliation tests for new defaults, user overrides, and deleted defaults, then run the patch migration and rollback tests; exercise install/update on Windows, macOS, and Linux and verify both the config and helper afterward |
| The pinned Pi Web runtime resolves private `@earendil-works/pi-coding-agent` and `@earendil-works/pi-agent-core` 0.84.3 modules and can carry the two exact Pi #8782 backport runtime hunks without changing standalone `dist/bundle/cli.js` | `lib/pui-pi-8782-backport.js`, `piWeb`, `upstream.agentRuntime` | Resolve the installed package tree from Pi Web, run the exact npm-artifact verifier, inspect both target paths, and compare the patched behavior with upstream merge `56700d42ed65a94a80af7376adb19a9298065164` |
| Pi Web build outputs still contain the targeted branding and icon metadata files | branding and icon helpers | Run helper tests and inspect the installed package |
| Pi Web 0.8.11 contains the exact `/api/app-update` route and prerendered app anchors | `pui-web-integration.js` | Run the exact-version integration fixture before release |
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
7. Across supported GPT, Claude, and Gemini model families, exercise explicit questionnaires, unresolved user-owned choices, context-resolved choices, low-risk delegated choices, batches over four independent questions, dependent follow-ups, recommendations, reserved labels, and preview/multi-select conflicts in both the terminal and Pi Web; record missed questions and unnecessary interruptions.
8. Run `/fff-status`, fuzzy path resolution, and indexed content search on each supported platform.
9. Confirm the six managed Playwright tools register directly while a non-direct tool remains discoverable and callable through the `mcp` proxy.
10. Add two supported OAuth accounts with `pi-accounts` and switch between them in both the terminal and Pi Web.
11. Run `/usage` for the active provider and toggle `/fast` for a supported Codex model in both the terminal and Pi Web.
12. Run a finite `bg_start` task, retrieve it with `bg_wait`, inspect output with `bg_logs`, and attach to a PTY task on each supported platform.
13. With `openai-codex/gpt-5.6-sol` → `openai-codex/gpt-5.6-luna` in `~/.config/pui/subagents.json`, spawn from `openai-codex/gpt-5.6-sol` without `model` or `thinking` and confirm fuzzy resolution selects available Luna with the parent's active reasoning level. Make Luna unavailable and confirm fallback to Sol; then confirm explicit model and reasoning overrides. Change and delete the mapping, run an update, and confirm those user choices survive while a newly shipped fixture mapping is appended. Repeat the invocation checks in both the terminal and Pi Web; from supported Claude and Gemini parents with no matching mapping, confirm parent-model and active-reasoning inheritance.
14. In a Pi Web session, produce a large tool result that crosses the normal context threshold and confirm compaction completes before the next provider request, the same run resumes with the tool result and queued steering, and a terminating tool does not trigger unnecessary compaction; confirm standalone `pi` remains stock until the upstream release.

Record the results in the release notes.

### v1.0.4 functional results (2026-08-26)

Manual v1.0.4 checks for structured questions, fuzzy file search, and the hybrid direct/proxy Playwright surface passed.
