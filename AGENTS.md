# PUI repository instructions

## Purpose and boundaries

PUI is a composition profile for vanilla Pi. It installs exact upstream components without a separate PUI runtime process, persistent service, retained checkout, or Pi fork. A small inert update extension and an exact Pi Web integration remain installed.

- Treat `stack.json` as the source of truth for exact managed package versions, retired packages, paths, tools, MCP configuration (including `mcpFooterStatus`), web routing, pi-goal continuation limits, and the Pi Web endpoint. `package.json.version` is the source release version; the installed update-extension manifest is the installed identity.
- Preserve unrelated user configuration. Back up existing JSON before changing it, validate inputs, and use structural merges instead of textual replacement.
- Perform installation and update mutations through the repository entry points. Do not document or introduce a manual sequence that bypasses `install.*` or `update.*`.
- Do not modify user projects, sessions, authentication, skills, model/provider configuration, or unrelated MCP entries.
- Uninstall only an integration entry that still matches the complete PUI-owned shape. Preserve entries the user has changed.

## Architecture

- `install.ps1` and `install.sh` perform prerequisite checks, backups, package installation, configuration, branding, icons, optional autostart, and smoke validation.
- `update.ps1` and `update.sh` delegate normal updates to `lib/pui-updater.js`; staged apply mode reconciles exact state and reapplies build overrides.
- `doctor.ps1` and `doctor.sh` are read-only diagnostics.
- `uninstall.ps1` and `uninstall.sh` remove owned integration; full mode also removes managed packages and global Pi executables.
- `lib/pui-config.js` owns JSON backup and merge operations.
- `lib/pui-stack.js` returns typed `stack.json` values to shell scripts; string values must remain unquoted.
- `lib/pui-branding.js` and `lib/pui-icons.js` patch the installed Pi Web build and store originals as `*.pui-original` for restoration.
- `lib/pui-goal-patch.js` owns the PUI-managed, idempotent, version-anchored patch to the installed `@narumitw/pi-goal` bundle. It replaces `formatStatus` with a structured `Goal: <status> · <reason> · <counter>` implementation (counter omitted when `automaticTurns` is `null`), patches the completion path to include elapsed time, preserves upstream's eight-second completion-status clear, calls only cross-chunk imported helpers whose names the bundler preserves, is re-applied by install and update after every `pi install @narumitw/pi-goal`, marked with sentinel comments for idempotency, and fails fast when its function boundaries drift.
- `lib/pui-native-check.js` verifies the `node-pty` binding required by `@99percentpeople/pi-background-tasks`; install/update approve only that managed dependency's lifecycle scripts and rebuild it when its bundled prebuild cannot load, failing the lifecycle phase if the binding remains unavailable.
- `lib/pui-release.js`, `lib/pui-updater.js`, `lib/pui-update-extension.js`, and `lib/pui-web-integration.js` own release validation, transaction/rollback, installed identity, and the exact Pi Web bridge.
- `assets/icons/` contains the complete committed icon source set. Do not edit installed copies as the source of truth.

Keep the PowerShell and shell workflows behaviorally equivalent except for platform-specific autostart. When changing a lifecycle phase, inspect and update both implementations and their tests.

## Development workflow

1. Trace the relevant install, update, doctor, and uninstall paths before editing.
2. For behaviorally significant or regression-sensitive changes—especially lifecycle, package/config, API/bridge, persistence, security, compatibility, and failure-handling changes—add or update a regression test first and observe it fail. For purely cosmetic, copy, formatting, or mechanical edits, do not add tests solely to satisfy this rule; update an existing assertion only when it intentionally covers the changed contract.
3. Make the smallest change that restores the intended invariant.
4. Update user documentation when commands, ownership, requirements, or behavior change.
5. Run verification proportional to the change before declaring completion: use the complete verification set for behavioral or integration changes, and focused checks for low-risk cosmetic, copy, formatting, or mechanical edits.

Use existing Node.js standard-library helpers unless a new dependency is demonstrably necessary. Propagate package-manager, helper, autostart, and health-check failures instead of reporting success after a partial setup.

## Verification

For behavioral, lifecycle, API, integration, package/config, security, compatibility, or regression-sensitive changes, run the complete Node test suite:

```bash
npm test
```

For purely cosmetic, copy, formatting, or mechanical changes, use focused validation proportional to the change and do not add tests unless an existing assertion intentionally covers the changed contract.

Parse all shell entry points:

```bash
for f in install.sh update.sh uninstall.sh doctor.sh; do bash -n "$f"; done
```

Parse all PowerShell entry points:

```powershell
foreach ($f in @('install.ps1','update.ps1','uninstall.ps1','doctor.ps1')) {
  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD $f), [ref]$tokens, [ref]$errors)
  if ($errors) { throw "Parse failure in ${f}: $($errors[0].Message)" }
}
```

For lifecycle changes, also exercise the relevant repository script on the target platform when it is safe to do so. Never weaken or skip a failing assertion to obtain a pass; diagnose the mismatch or report the remaining gap.

## Completion checklist

- Managed package additions and retirements are represented in `stack.json`, both platform implementations, diagnostics, uninstall behavior, and tests.
- Branding and icon changes survive update and can be restored by uninstall.
- Installed identity, bridge health, exact versions, idle gating, and rollback to the previous certified composition are verified.
- Existing unrelated settings remain intact and invalid JSON fails safely after a backup.
- Relevant validation passes with fresh output; behavioral and integration changes also pass `npm test`, PowerShell parsing, and shell parsing.
- Documentation contains real commands, valid relative links, and no unreplaced planning placeholders.

Do not commit generated global-package files, local configuration, credentials, runtime logs, or `*.pui-original` backups from an installed Pi Web tree.
