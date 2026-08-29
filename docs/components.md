# PUI components

PUI is a composition profile with no separate runtime process, daemon, persistent control directory, retained checkout, or Pi fork. A small installed update extension records the certified PUI version and composition, while an exact-version Pi Web patch provides app-level discovery and explicit update controls.

## Upstream components

| Capability | Package | Configuration | Notes |
|---|---|---|---|
| Agent runtime | `@earendil-works/pi-coding-agent` | Pi settings | Standalone CLI aligned to Pi Web's bundled version |
| GUI | `@agegr/pi-web` | Pi Web build | Loopback `127.0.0.1:30141`; `--no-open` for autostart |
| Subagents | `@gotgenes/pi-subagents` | Pi package entry + PUI-owned source patch + user mapping config | In-process subagents with fuzzy mapped-model defaults and parent reasoning inheritance |
| Web search and fetch | `pi-web-access` | `~/.pi/web-search.json` | Anonymous Exa, DuckDuckGo fallback, direct HTTP fetch |
| MCP adapter | `pi-mcp-adapter` | `~/.config/mcp/mcp.json` | Proxy-first MCP layer with selected direct tools; footer status hidden (`mcpFooterStatus=off`) |
| Browser automation | `@playwright/mcp` | `~/.config/mcp/mcp.json` | Lazy, headless Chrome; `browser_navigate` and five other common tools direct, long tail proxied |
| Goal completion | `@narumitw/pi-goal` | `~/.pi/agent/pi-goal.json` | Session-scoped `/goal` mode; unlimited automatic turns (`automaticTurns=null`) with a readable `Goal: <status> · <reason> · <counter>` status line via a PUI-managed dist patch |
| Account switching | `@narumitw/pi-accounts` | Extension-owned account state | Named subscription OAuth accounts across supported providers |
| Provider usage | `@narumitw/pi-usage` | Pi package entry | `/usage` and `/fast` for current-provider limits and Codex Fast mode |
| Structured questions | `@juicesharp/rpiv-ask-user-question` | `~/.config/rpiv-ask-user-question/config.json` | Typed choices, free-form answers, and compact PUI-managed model guidance |
| Fuzzy file navigation | `pi-fff` | Extension-owned feature state | Fuzzy references, path resolution, and indexed content search; startup notices and custom agent tools suppressed via PUI-managed feature config |
| Background tasks | `@99percentpeople/pi-background-tasks` | Pi package entry + PUI-owned prompt patch + native dependency | `bg_*` pipe and PTY tasks with compact model guidance; install/update verifies and can rebuild `node-pty` |
| PUI update identity | PUI-owned `pui-update` extension | `~/.pi/agent/extensions/pui-update/manifest.json` | Inert unless invoked; no polling or daemon |

## Managed files and fields

PUI structurally merges the configuration JSON files below after making timestamped backups. The native recovery path also backs up `~/.pi/agent/npm/package.json` before asking npm to record its exact `node-pty` script approval:

- `~/.pi/agent/settings.json`: `defaultTools` and managed package entries
- `~/.pi/web-search.json`: `searchRouting`, `fetchRouting`, and `workflow`
- `~/.config/mcp/mcp.json`: `mcpServers.playwright.command`, `args`, the six-tool `directTools` policy, and `settings.mcpFooterStatus`
- `~/.pi/agent/pi-goal.json`: `continuationLimits.automaticTurns` and `continuationLimits.noProgressTurns`
- `~/.config/rpiv-ask-user-question/config.json`: exact `guidance.description`, `guidance.promptSnippet`, and `guidance.promptGuidelines` values; an existing absolute `$XDG_CONFIG_HOME/rpiv-ask-user-question/config.json` takes precedence
- `~/.pi/agent/npm/package.json`: only the exact `node-pty` lifecycle approval when a native rebuild is required
- `~/.pi/agent/npm/node_modules/@99percentpeople/pi-background-tasks/index.min.js`: exact PUI-owned tool descriptions, prompt snippets, parameter descriptions, and six shared guidelines; the upstream bundle is retained as `index.min.js.pui-original` and ownership hashes as `index.min.js.pui-manifest.json`
- `~/.pi/agent/npm/node_modules/@gotgenes/pi-subagents/` sources listed by `stack.json.subagentsPromptPatch.files`: exact PUI-owned mapped-model and parent-reasoning policy; each upstream file is retained as `<file>.pui-original` and ownership hashes as `.pui-subagents-prompt-manifest.json`
- `~/.config/pui/subagents.json`: user-editable fuzzy model mappings plus `_pui.defaultMappings` reconciliation metadata; updates preserve user changes and deletions while adding newly shipped defaults
- Pi Web's resolved unbundled `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` and `@earendil-works/pi-agent-core/dist/agent-loop.js`: temporary exact Pi #8782 runtime backport; originals are retained beside the targets as `*.pui-8782-original` and ownership hashes as `.pui-pi-8782-backport.json`
- `~/.pi/agent/extensions/pui-update/`: installed PUI identity and detached transaction worker

PUI owns the exact package pins for its added extensions, but it does not manage their account state, logs, or optional fields except where listed above. For `rpiv-ask-user-question`, install and update replace only the three managed guidance leaves while preserving fields such as `collapseKey` and unknown guidance siblings. Doctor requires an exact guidance match. Uninstall checks both the absolute XDG and legacy paths, backs up each matching file, and removes the exact PUI-managed guidance leaves only while they still match the complete owned shape; user-modified guidance is preserved.

For `@99percentpeople/pi-background-tasks`, PUI replaces the pinned 2.1.1 bundle's 27 overlapping prompt guidelines and verbose tool/schema descriptions with six compact shared guidelines and concise per-tool metadata. The version-anchored transform is sentinel-marked and idempotent, fails closed on metadata drift, is reapplied after each package reconciliation, and rebases its ownership artifacts onto the pristine bundle when `pi install` replaces the package for a new pinned version. Its hashed manifest records the pristine and patched bytes, allowing a later PUI-owned prompt revision to rebuild from the pristine backup without accepting user-modified output. Update transactions back up the bundle, original, and ownership manifest before mutation; staged target scripts retain this snapshot under one transaction-level guard until the enclosing worker reports success, so the introducing update remains reversible under an older installed worker. Doctor compares the installed bundle with the exact transform of its `index.min.js.pui-original`; uninstall restores that backup only while the installed output remains an exact PUI-owned match. The lifecycle entry points also verify that `node-pty` loads and approve/rebuild that dependency only when the bundled prebuild cannot load. For `@narumitw/pi-goal`, PUI replaces the installed `formatStatus` bundle with a structured implementation that emits a readable `Goal: <status> · <reason> · <counter>` line (for example `Goal: paused · usage · 0/25`), with the counter omitted entirely when turns are unlimited. The completion path emits `Goal: complete · <elapsed>` before preserving upstream's eight-second status clear. The replacement calls only cross-chunk imported helpers whose names the bundler preserves, never minified same-chunk locals. The patch is version-anchored to the pinned pi-goal release, marked with sentinel comments for idempotency, re-applied by install and update after every `pi install @narumitw/pi-goal`, and fails fast when its function boundaries drift so a version bump surfaces loudly instead of silently shipping an unpatched status line.

For `@gotgenes/pi-subagents`, PUI applies configurable default model and reasoning resolution. `~/.config/pui/subagents.json` contains parent-to-child mappings, initially the exact pair `openai-codex/gpt-5.6-sol` → `openai-codex/gpt-5.6-luna`. Custom mappings may still use fuzzy names. Both sides use the same exact-then-fuzzy resolver as the subagent tool's explicit `model` argument. If multiple keys resolve to the active parent, the invocation reports a configuration error; if the mapped child is unavailable, resolution falls back to the parent. An explicit invocation `model` wins over the mapping. An explicit invocation `thinking` also wins; when omitted, the child inherits the parent session's active reasoning level and Pi subsequently clamps it to the resolved child's capabilities. Agent-profile model and thinking defaults do not supersede these parented tool-invocation rules, and the built-in `Explore` haiku pin remains removed.

```json
{
  "schemaVersion": 1,
  "modelMappings": {
    "openai-codex/gpt-5.6-sol": "openai-codex/gpt-5.6-luna"
  },
  "_pui": {
    "defaultMappings": {
      "openai-codex/gpt-5.6-sol": "openai-codex/gpt-5.6-luna"
    }
  }
}
```

Users edit `modelMappings`; `_pui.defaultMappings` records the last defaults PUI offered so later updates can distinguish an untouched mapping from one the user changed or removed.

Install and update reconcile shipped defaults through the config's `_pui.defaultMappings` metadata. A newly shipped key is added, an untouched shipped value can be updated or retired, and a mapping the user changed or deleted is preserved. Unrelated fields also remain intact. The version-anchored source transform is sentinel-marked and idempotent, fails closed on version or metadata drift, is reapplied after package reconciliation, and rebases its ownership artifacts when `pi install` replaces the pinned package. Doctor validates both the user mapping schema and the installed transform. Update transactions back up the config and every source ownership artifact before mutation; uninstall restores source backups only while the installed files remain an exact PUI-owned match and leaves the user mapping config in place.

PUI's Pi #8782 backport is a temporary exact-version compatibility shim for the runtime used by Pi Web. Pi 0.84.3 can let a completed tool result cross the normal threshold before the next provider request; PUI's helper backports only upstream PR #8782's agent-loop scheduling and AgentSession between-turn compaction into the resolved unbundled Pi Web dependency tree. It does not patch the standalone bundled `pi` CLI (`dist/bundle/cli.js`), change compaction thresholds, add a new dependency, build Pi, or include the upstream TUI progress-indicator hunk. The standalone CLI therefore remains stock 0.84.3 while Pi Web uses 0.84.3 plus this backport. The helper resolves private packages from Pi Web rather than guessing a global path, requires the exact `@agegr/pi-web` 0.8.11 / Pi 0.84.3 composition, transforms both files in memory, syntax-checks them, records a hashed ownership manifest, and restores both originals only when the complete owned shape remains intact. Install and update apply it after runtime parity and before restart; doctor fails when it is absent or drifted; uninstall removes it from the default path; the helper is retired when PUI pins the first released Pi version containing #8782.

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
|   |-- pui-background-tasks-patch.js compact model-guidance patch and restore helper
|   |-- pui-subagents-patch.js mapped model/reasoning policy and restore helper
|   |-- pui-pi-8782-backport.js temporary Pi #8782 Pi Web runtime patch and restore helper
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
