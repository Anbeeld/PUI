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
| `@narumitw/pi-goal` exposes elapsed goal time, clears its completion status after the upstream eight-second timer, and retains the exact prompt/tool/turn-end anchors needed to replace the 4,000-character summary cap with Pi's 50 KB UTF-8 boundary and promote only an accepted complete summary after the inactive contract without another model turn | `piPackages`, `lib/pui-goal-patch.js` | Apply the helper to the exact pinned artifact, syntax-check both patched files, and run the patch regression tests, including exact/over-limit ASCII and multibyte summaries plus rejected/accepted completion ordering |
| `@99percentpeople/pi-background-tasks` retains the exact 2.1.1 tool metadata anchors patched by PUI, loads `node-pty` from bundled prebuilt binaries on every supported platform, and permits PUI to approve/rebuild its lifecycle scripts when a prebuild is unavailable | `piPackages`, `backgroundTasksPromptPatch`, `lib/pui-background-tasks-patch.js`, `lib/pui-native-check.js` | Run `npm run release:verify-prompt-patches` against the exact published artifact, then run the owned-transform migration/rollback tests against the pinned bundle; run the PUI install/update entry point on Windows, macOS, and Linux (x64/arm64); verify both helpers afterward and confirm a PTY spawns |
| `@gotgenes/pi-subagents` 19.3.5 retains the exact taxonomy/routing/capability, unknown-type, completion, mapped-model, reasoning, registry-overlay, and tool-schema patch anchors; child sessions bind `pi-web-access` extension tools before applying profile allowlists | `piPackages`, `subagents`, `subagentsPromptPatch`, `configPaths.puiSubagents`, `lib/pui-subagents-patch.js` | Run `npm run release:verify-prompt-patches` against the exact published artifacts. Its runtime harness verifies background-default profiles, explicit foreground override precedence, exact tool sets, case-insensitive custom/default overrides, added custom profiles, fail-closed unknown types, inherited-prefix prompt rendering, parallelism-gated route guidance, mapping fallback/overrides, reasoning inheritance/schema, idempotency, and restoration. Run every known revision migration/removal, interruption recovery, restore-failure retention, unknown-manifest, and case-insensitive config reconciliation test; then exercise install/update on each platform |
| The pinned Pi Web and standalone Pi artifacts retain the exact Responses parser, TUI/Web renderer, reconnect-event, streaming-reconnect transcript reconciliation, preview, context, deferred-thinking, HTML-export, and Pi Web custom-message expansion/Markdown-class seams required for safe transcript display, compaction-style `Goal complete` bodies, and live collapsed subagent notifications | `reasoningSummaryPatch`, `lib/pui-reasoning-summary-patch.js`, `piWeb`, `upstream.agentRuntime` | Run `npm run release:verify-reasoning-summary`; it installs the exact published artifacts in isolation, applies branding before the reasoning transform, syntax-checks every owned target, verifies Goal-only typography and live custom-prompt reconciliation plus both ownership manifests, and removes the transform |
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
15. In fresh sessions with the exact parent/child model and reasoning settings recorded, run `tests/fixtures/pi-subagents-routing-eval.json` and inspect the complete trajectories. Trivial and substantial single-track work, dependent analysis followed by editing, sequential current-source research, decided sequential implementation, and the overall plan must stay in main. One background agent is valid only while main continues a substantial independent track; two or more agents must all run in background on independent tracks. Any ordinary foreground spawn, idle-parent delegation, overlapping mutable ownership, capability/trust-boundary violation, or silent unknown-type fallback blocks release. Repeat an explicit user-requested foreground case to confirm that narrow override remains available.
16. Complete `/goal` once with a multiline direct user-facing deliverable and once with a rejected stale-id call in Pi Web and standalone Pi. Confirm the accepted summary appears after the collapsed Process details as an expanded durable `Goal complete` message, survives reload, does not trigger another provider request, uses Pi Web's 1.5-line-height compaction Markdown typography while another expanded generic custom message retains its upstream style, and includes the deliverable rather than promising a later response; confirm the rejected result remains only in Process details.

Record the results in the release notes.

### v1.2.0 subagent routing evaluation (2026-08-29)

The controlled prompt-routing comparison used two fresh `openai-codex/gpt-5.6-luna` sessions at `high` reasoning. Both sessions received the same eight cases and scoring rubric now preserved at `tests/fixtures/pi-subagents-routing-eval-v1.json`; one received the parent tool description rendered from the revision-4 baseline and one received the description rendered from the revision-6 candidate. Revision 6 layers this taxonomy change over the already-owned revision-5 completion-delivery patch. The rendered descriptions came from isolated copies of the exact published `@gotgenes/pi-subagents@19.3.5` artifact after the corresponding PUI transform.

| Measurement | Revision-4 baseline | Revision-6 candidate |
|---|---:|---:|
| Missed specialist opportunities | 1 | 0 |
| Over-delegations of retained main-agent work | 2 | 0 |
| Ambiguous routes | 4 | 0 |
| Candidate policy violations | n/a | 0 |

| Fixture case | Revision-4 route/result | Revision-6 route/result |
|---|---|---|
| Trivial local read | `Explore` / acceptable but unnecessary | main / acceptable direct work |
| Current upstream evidence | main web tools / missed specialist route | `Research` / expected route |
| Decided bounded execution | `general-purpose` / execution route | `Worker` / expected route |
| Architecture plus execution | `general-purpose` / ownership ambiguous | main, then optional `Worker` / ownership retained |
| Mixed local and upstream | `Explore` plus main web tools / coordination ambiguous | main coordinates `Explore` + `Research` / expected route |
| Trivial known edit | main / expected direct work | main / expected direct work |
| Overall plan | `Plan` / main ownership transferred | main / expected ownership |
| Unknown explicit type | fail closed / expected runtime behavior | fail closed / expected runtime behavior |

The candidate routed current upstream evidence to `Research`, decided bounded execution to `Worker`, mixed local/current work to main-coordinated `Explore` plus `Research`, architecture and planning to main, trivial work to main, and an unknown explicit type to the fail-closed path. Deterministic runtime checks additionally verified exact profile tool allowlists, prompt placement after the inherited prefix, disabled and user-defined types, unknown-type rejection, model/reasoning inheritance, idempotency, restore, migration, and rollback. `npm run release:verify-prompt-patches` passed against newly downloaded pinned artifacts. Direct standalone CLI repetitions with `openai-codex/gpt-5.6-sol` and `openai-codex/gpt-5.6-luna` at `high` reasoning were attempted but produced no model output because the provider reported its usage limit; they were not counted as evidence or as passes.

### v1.2.0 revision-7 prompt and ownership audit (2026-08-29)

A prompting-skill review re-read the rendered parent tool description and all three child prompts with weak/local-model routing as an explicit criterion. Revision 7 adds explicit route and prompt recipes, foreground/background selection based on dependencies and useful independent work, result/failure handling, Worker source-data distrust, Research target-version precedence, and a literal-union reasoning schema. It removes the generic “provide clear, detailed prompts” exhortation without expanding the three-role taxonomy.

The ownership audit verified user profile and model-mapping paths separately from PUI-owned installed source. It added case-insensitive user-profile overlay, case-safe mapping reconciliation with unpadded unique keys, missing-file parent-model fallback, strict manifest revision/schema checks, exact migration/removal for known revisions 1, 3, 4, 5, and 6, no-write idempotency, atomic artifact writes, durable interruption recovery, and retained evidence after a restore failure. Project/global profile files and unrelated mapping fields remain outside lifecycle mutation.

### v1.2.1 revision-9 parallel-only default routing

Revision 9 separates delegation eligibility from specialist selection. Main keeps the coherent critical path; default delegation requires either one substantial independent background track alongside substantial main work or at least two independent background agent tracks. Sequential, dependent, tool-heavy, context-heavy, local, external, and specialist-compatible work stays in main unless it also passes that parallelism gate. `Worker`, `Explore`, and `Research` now default to background execution, while an explicit user `run_in_background: false` overrides the profile default. The schema-2 routing fixture scores sequential delegation and an idle parent as regressions, and revision-8 migration/uninstall coverage verifies the preceding owned shape. Behavioral model evaluation of the final rendered revision remains a release requirement under step 15 above.

### v1.0.4 functional results (2026-08-26)

Manual v1.0.4 checks for structured questions, fuzzy file search, and the hybrid direct/proxy Playwright surface passed.
