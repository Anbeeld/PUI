# PUI repository instructions

## Purpose and boundaries

PUI is a setup-time composition profile for vanilla Pi. It installs and configures upstream components without introducing a PUI runtime or maintaining a Pi fork.

- Treat `stack.json` as the source of truth for managed packages, retired packages, paths, tools, MCP configuration, web routing, and the Pi Web endpoint.
- Preserve unrelated user configuration. Back up existing JSON before changing it, validate inputs, and use structural merges instead of textual replacement.
- Perform installation and update mutations through the repository entry points. Do not document or introduce a manual sequence that bypasses `install.*` or `update.*`.
- Do not modify user projects, sessions, authentication, skills, model/provider configuration, or unrelated MCP entries.
- Uninstall only an integration entry that still matches the complete PUI-owned shape. Preserve entries the user has changed.

## Architecture

- `install.ps1` and `install.sh` perform prerequisite checks, backups, package installation, configuration, branding, icons, optional autostart, and smoke validation.
- `update.ps1` and `update.sh` refresh the same managed state and reapply build overrides after Pi Web changes.
- `doctor.ps1` and `doctor.sh` are read-only diagnostics.
- `uninstall.ps1` and `uninstall.sh` remove owned integration; full mode also removes managed packages and global Pi executables.
- `lib/pui-config.js` owns JSON backup and merge operations.
- `lib/pui-stack.js` returns typed `stack.json` values to shell scripts; string values must remain unquoted.
- `lib/pui-branding.js` and `lib/pui-icons.js` patch the installed Pi Web build and store originals as `*.pui-original` for restoration.
- `assets/icons/` contains the complete committed icon source set. Do not edit installed copies as the source of truth.

Keep the PowerShell and shell workflows behaviorally equivalent except for platform-specific autostart. When changing a lifecycle phase, inspect and update both implementations and their tests.

## Development workflow

1. Trace the relevant install, update, doctor, and uninstall paths before editing.
2. Add or update a regression test first and observe it fail for behavioral fixes.
3. Make the smallest change that restores the intended invariant.
4. Update user documentation when commands, ownership, requirements, or behavior change.
5. Run the complete verification set before declaring completion.

Use existing Node.js standard-library helpers unless a new dependency is demonstrably necessary. Propagate package-manager, helper, autostart, and health-check failures instead of reporting success after a partial setup.

## Verification

Run the complete Node test suite:

```bash
npm test
```

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
- Existing unrelated settings remain intact and invalid JSON fails safely after a backup.
- `npm test`, PowerShell parsing, and shell parsing pass with fresh output.
- Documentation contains real commands, valid relative links, and no unreplaced planning placeholders.

Do not commit generated global-package files, local configuration, credentials, runtime logs, or `*.pui-original` backups from an installed Pi Web tree.
