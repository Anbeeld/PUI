# Changelog

## v1.1.0

- Updated all managed upstream components to their latest releases: `@agegr/pi-web` 0.8.11, `pi-mcp-adapter` 2.29.0, `@narumitw/pi-goal` 0.54.3, `@narumitw/pi-accounts` 0.49.11, and `@narumitw/pi-usage` 0.52.3 (`@earendil-works/pi-coding-agent` 0.84.3, `@gotgenes/pi-subagents` 19.3.5, `pi-web-access` 0.25.0, `@playwright/mcp` 0.0.79, `@juicesharp/rpiv-ask-user-question` 2.7.1, and `pi-fff` 0.1.12 were already current). Re-validated the pi-goal `formatStatus` patch and the Pi Web update bridge against the bumped builds.
- Made the Pi Web update bridge's route matcher derive its expected version from `stack.json` so a Pi Web bump no longer requires editing the bridge source.
- Configured `@narumitw/pi-goal` for unlimited automatic `/goal` turns by setting `continuationLimits.automaticTurns` to `null` in `~/.pi/agent/pi-goal.json`, applied across install, update, and diagnostics.
- Replaced pi-goal's terse `usage · automatic 0/25` status line with a readable `Goal: <status> · <reason> · <counter>` format (e.g. `Goal: paused · usage · 0/25`), with the counter omitted when turns are unlimited, via a PUI-managed, idempotent, version-anchored patch that replaces the installed `formatStatus` function. Completed goals retain elapsed time in `Goal: complete · <elapsed>` and still clear after upstream's eight-second completion-status timer; the patch re-applies on every install and update and fails fast on pi-goal version drift.
- Hid the `pi-mcp-adapter` footer status (`MCP: N server(s) enabled`) from the extension status bar by setting `mcpFooterStatus` to `off` in `~/.config/mcp/mcp.json`, applied across install, update, and diagnostics.
- Configured the `pi-fff` extension to suppress per-session startup notices while keeping fuzzy path resolution, content search, and autocomplete active, applied across install, update, and diagnostics.
- Added the exact managed `@99percentpeople/pi-background-tasks` pin at 2.1.1. Install and update now verify its required `node-pty` binding, approve only that dependency's lifecycle scripts when a bundled prebuild cannot load, and fail closed if a rebuild still cannot produce a working native binding.
- Made the manual updater surface an actionable message when the local repo version is not a published GitHub release, pointing to `-ApplyStaged` / `--apply-staged` instead of failing with a raw `GitHub returned HTTP 404`.
- The Pi Web update card now always shows a close button (including during install and on terminal results) and re-appears with its reload action when an update the user dismissed reaches a terminal status.
- Windows entry points (`install.ps1`, `update.ps1`, `uninstall.ps1`, `doctor.ps1`) now stay open after finishing or failing so output can be read, unless they are driven as a non-interactive child (suppressed via `PUI_NONINTERACTIVE`).
- Added an always-visible Restart PUI button to the Pi Web update card surface. It reuses the card styling, sits below the update notification, and triggers a one-command Pi Web restart (kill + relaunch) through a new `PUT /api/app-update` action, then reloads the page once Pi Web is back.
- Hardened the updater's Pi Web reinstall and restart steps: it now polls until the stopped Pi Web process is actually gone, retries `npm install` on transient `EBUSY` (Windows file-lock release), requires consecutive HTTP 200 responses after relaunch, and surfaces the real npm/health error if recovery still fails.

## v1.0.6

- Added the exact managed `@narumitw/pi-accounts` pin across install, update, diagnostics, full uninstall, and documentation.

## v1.0.5

- Fixed Windows updates by passing the managed Playwright MCP definition through a temporary file that Windows PowerShell 5.1 preserves correctly.

## v1.0.4

- Added exact managed pins for `@juicesharp/rpiv-ask-user-question` and `pi-fff` across install, update, diagnostics, and full uninstall workflows.
- Documented structured questions, fuzzy file navigation, ownership boundaries, and required cross-platform compatibility checks.
- Prevented stale successful update records from showing the wrong installed version on first load.
- Made updates reconcile compatible Playwright MCP entries to the exact managed version before validation.
- Promoted six common Playwright operations, starting with `browser_navigate`, to direct Pi tools while keeping the remaining MCP surface proxied on demand.

## v1.0.3

- Pinned every PUI-managed direct component, including Playwright MCP, to an exact release version.
- Added an installed PUI identity extension, exact Pi Web update bridge, and Pi Web-themed update card.
- Added a shared detached transaction worker with idle gating, explicit checkpoint routing, temporary status, automatic rollback, and recovery-required reporting.
- Made manual updates use the same transaction path and expanded read-only doctor and ownership-safe uninstall checks.
- Hardened reinstall and update safety across Windows, macOS, and Linux by failing closed when Pi Web activity cannot be verified and recognizing npm-launched standalone Pi processes.

## v1.0.2

- Adjusted browser and PWA title composition so the PUI label appears once in each context.
- Added content-hash versioning to PUI-modified client bundles.
- Marked all Unix lifecycle scripts as executable for direct launch on macOS and Linux.

## v1.0.1

- Refreshed PUI icon assets.
- Added versioning to icon references, including browser metadata, the PWA manifest, and the service-worker precache.
