const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const unixEntryPoints = ["install.sh", "update.sh", "uninstall.sh", "doctor.sh"];

test("Unix entry points are executable in Git", () => {
  const result = spawnSync("git", ["ls-files", "--stage", "--", ...unixEntryPoints], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const modes = new Map(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [mode, , , file] = line.split(/\s+/);
        return [file, mode];
      }),
  );
  for (const file of unixEntryPoints) assert.equal(modes.get(file), "100755", file);
});

test("Unix entry points retain LF endings in Windows worktrees", () => {
  assert.match(read(".gitattributes"), /^\*\.sh text eol=lf$/m);
  for (const file of unixEntryPoints) {
    assert.equal(fs.readFileSync(path.join(repoRoot, file)).includes(Buffer.from("\r\n")), false, file);
  }
});

test("all Unix entry points use the shared stack reader", () => {
  for (const file of unixEntryPoints) {
    const content = read(file);
    assert.match(content, /lib\/pui-stack\.js/);
    assert.doesNotMatch(content, /process\.stdout\.write\(JSON\.stringify\(v\)\)/);
  }
});

test("Unix lifecycle JavaScript snippets pass filesystem paths as arguments", () => {
  for (const file of unixEntryPoints) {
    assert.doesNotMatch(read(file), /require\(['"]\$(?:STACK|PIWEB_PKG|PI_SETTINGS|PI_WEB_ACCESS|MCP_SHARED|nested|hoisted|pw_pkg)/, file);
  }
});

test("Unix branding does not depend on platform-specific sed -i", () => {
  for (const file of ["install.sh", "update.sh"]) {
    assert.doesNotMatch(read(file), /sed -i/);
  }
});

test("updaters delegate to the shared transaction worker and retain only model refresh", () => {
  const shell = read("update.sh");
  assert.match(shell, /lib\/pui-updater\.js/);
  assert.doesNotMatch(shell, /pi update --extensions/);
  assert.doesNotMatch(shell, /pi update --models[^\n]*\|\| true/);

  const powershell = read("update.ps1");
  assert.match(powershell, /lib[\\/]pui-updater\.js/);
  assert.doesNotMatch(powershell, /pi update --extensions/);
  assert.match(powershell, /modelsExit/);
});

test("updaters reconcile the exact managed Playwright MCP definition before validation", () => {
  for (const file of ["update.ps1", "update.sh"]) {
    const content = read(file);
    const reconciliation = content.indexOf("set-server");
    const migrationBoundary = content.indexOf("config-migration");

    assert.notEqual(reconciliation, -1, `${file}: missing MCP reconciliation`);
    assert.ok(reconciliation < migrationBoundary, `${file}: MCP reconciliation must precede the migration boundary`);
    assert.match(content, /mcpShared|MCP_SHARED/, `${file}: shared MCP config path`);
    assert.match(content, /mcp\.serverName/, `${file}: managed MCP server name`);
  }
});

test("Windows updater passes MCP JSON through a file for Windows PowerShell compatibility", () => {
  const content = read("update.ps1");
  assert.match(content, /WriteAllText\(\$mcpDefFile, \$mcpDef/);
  assert.match(content, /"@\$mcpDefFile"/);
  assert.doesNotMatch(content, /"set-server"[^\r\n]*\$mcpDef(?:\s|$)/);
});

test("installer completion text names the retained PUI integration", () => {
  for (const file of ["install.ps1", "install.sh"]) {
    const content = read(file);
    assert.doesNotMatch(content, /just a normal Pi installation/);
    assert.match(content, /update extension and Pi Web integration (?:stay|remain) installed/i);
  }
});

test("Windows entry points stay open after running unless driven as a non-interactive child", () => {
  for (const file of ["install.ps1", "update.ps1", "uninstall.ps1", "doctor.ps1"]) {
    const content = read(file);
    assert.match(content, /function Wait-IfInteractive/, `${file}: Wait-IfInteractive helper`);
    assert.match(content, /PUI_NONINTERACTIVE/, `${file}: non-interactive guard`);
    const lastFinally = content.lastIndexOf("} finally {");
    assert.notEqual(lastFinally, -1, `${file}: outer finally present`);
    assert.ok(content.indexOf("Wait-IfInteractive", lastFinally) !== -1, `${file}: finally pause on every exit path`);
  }
  const update = read("update.ps1");
  assert.match(update, /\$env:PUI_NONINTERACTIVE = "1"[\s\S]*& \$doctorScript/, "update.ps1 suppresses the pause for the doctor smoke-suite child");
  const updater = fs.readFileSync(path.join(repoRoot, "lib", "pui-updater.js"), "utf8");
  assert.match(updater, /PUI_NONINTERACTIVE: "1"/, "spawned update runs inherit the non-interactive marker");
});

test("both staged apply paths expose the same material failure-injection boundaries", () => {
  const boundaries = ["package-reconciliation", "config-migration", "pi-web-integration", "pi-8782-backport", "extension-replacement", "restart-health", "target-validation"];
  for (const file of ["update.ps1", "update.sh"]) {
    const content = read(file);
    for (const boundary of boundaries) assert.match(content, new RegExp(boundary), `${file}: ${boundary}`);
  }
});

test("Pi #8782 backport is applied at the Pi Web runtime seam and is fatal", () => {
  for (const file of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = read(file);
    const npmInstall = content.indexOf(file.endsWith(".ps1")
      ? (file.startsWith("install") ? "installing @agegr/pi-web" : "updating @agegr/pi-web")
      : "npm install -g --ignore-scripts");
    const apply = content.indexOf("pui-pi-8782-backport.js");
    const restart = content.indexOf(file.endsWith(".ps1") ? "restarting pi-web" : "restarting LaunchAgent");
    assert.ok(npmInstall !== -1 && apply > npmInstall, `${file}: backport follows Pi Web installation`);
    assert.ok(restart === -1 || apply < restart, `${file}: backport precedes Pi Web restart`);
    assert.match(content, /pui-pi-8782-backport\.js/);
    assert.doesNotMatch(content.slice(apply, apply + 700), /\|\| true|catch \{\s*\}/, `${file}: backport failure is not ignored`);
  }
  const shellInstall = read("install.sh");
  assert.match(shellInstall, /pui-pi-8782-backport\.js" apply "\$SCRIPT_DIR" "\$PIWEB_PKG_ROOT"/);
  const shellUpdate = read("update.sh");
  const shellApply = shellUpdate.indexOf("pui-pi-8782-backport.js");
  assert.match(shellUpdate, /pui-pi-8782-backport\.js" apply "\$SCRIPT_DIR" "\$PIWEB_PKG_ROOT"/);
  assert.match(shellUpdate, /pui_fail pi-8782-backport/);
  assert.ok(shellUpdate.indexOf("pui_fail pi-8782-backport") > shellApply, "update.sh: backport failure boundary follows application");
  const psInstall = read("install.ps1");
  assert.match(psInstall, /pui-pi-8782-backport\.js[\s\S]*apply \$ScriptDir \$piWebPkgRoot/);
  const psUpdate = read("update.ps1");
  const psApply = psUpdate.indexOf("pui-pi-8782-backport.js");
  assert.match(psUpdate, /pui-pi-8782-backport\.js[\s\S]*apply \$ScriptDir \$piWebPkgRoot/);
  assert.match(psUpdate, /Assert-NoInjectedFailure "pi-8782-backport"/);
  assert.ok(psUpdate.indexOf('Assert-NoInjectedFailure "pi-8782-backport"') > psApply, "update.ps1: backport failure boundary follows application");
});

test("Pi Web artifact verifier extracts archives from its temporary working directory", () => {
  const verifier = read("tests/verify-pi-web-integration.js");
  assert.match(verifier, /spawnSync\("tar", \["-xf", archive, "-C", "\."\], \{ cwd: temp/);
});

test("Pi #8782 backport doctor and uninstall operations are symmetric", () => {
  assert.match(read("doctor.sh"), /pui-pi-8782-backport\.js.*verify/);
  assert.match(read("doctor.ps1"), /pui-pi-8782-backport\.js[\s\S]*verify[\s\S]*\$ScriptDir[\s\S]*\$piWebRoot/);
  assert.match(read("uninstall.sh"), /pui-pi-8782-backport\.js" remove "\$PIWEB_ROOT"/);
  assert.match(read("uninstall.ps1"), /pui-pi-8782-backport\.js[\s\S]*remove \$piWebRoot/);
});

test("introducing staged updates locally roll back all managed prompt artifacts", () => {
  const powershell = read("update.ps1");
  const psSnapshot = powershell.indexOf("snapshot $backgroundSnapshot");
  const psPackages = powershell.indexOf("package-reconciliation");
  const psGuard = powershell.indexOf("spawn-guard");
  const psCommit = powershell.indexOf("$backgroundPatchCommitted = $true");
  const psTarget = powershell.indexOf("target-validation");
  const psSubagentSnapshot = powershell.indexOf("snapshot $subagentsSnapshot");
  assert.ok(psSnapshot !== -1 && psSnapshot < psPackages, "update.ps1: background snapshot must precede package mutation");
  assert.ok(psSubagentSnapshot !== -1 && psSubagentSnapshot < psPackages, "update.ps1: subagent snapshot must precede package mutation");
  assert.ok(psGuard > psTarget && psCommit > psGuard, "update.ps1: outer-transaction guard must own the snapshot after target validation");
  assert.match(powershell, /backgroundGuardExit -eq 76/, "update.ps1: checkpoint routes reuse one transaction guard");
  assert.match(powershell, /guard-ready/, "update.ps1: guard startup must be acknowledged before return");
  assert.match(powershell, /finally \{[\s\S]*restore-snapshot[\s\S]*Wait-IfInteractive\s*\}/, "update.ps1: failure finally restores prompt artifacts");

  const shell = read("update.sh");
  const shSnapshot = shell.indexOf('snapshot "$BACKGROUND_SNAPSHOT"');
  const shPackages = shell.indexOf("package-reconciliation");
  const shGuard = shell.indexOf("spawn-guard");
  const shCommit = shell.indexOf("BACKGROUND_PATCH_COMMITTED=1");
  const shTarget = shell.indexOf("target-validation");
  const shSubagentSnapshot = shell.indexOf('snapshot "$SUBAGENTS_SNAPSHOT"');
  assert.ok(shSnapshot !== -1 && shSnapshot < shPackages, "update.sh: background snapshot must precede package mutation");
  assert.ok(shSubagentSnapshot !== -1 && shSubagentSnapshot < shPackages, "update.sh: subagent snapshot must precede package mutation");
  assert.ok(shGuard > shTarget && shCommit > shGuard, "update.sh: outer-transaction guard must own the snapshot after target validation");
  assert.match(shell, /BACKGROUND_GUARD_EXIT" -eq 76/, "update.sh: checkpoint routes reuse one transaction guard");
  assert.match(shell, /guard-ready/, "update.sh: guard startup must be acknowledged before return");
  assert.match(shell, /trap restore_background_patch_on_exit EXIT/, "update.sh: failure trap restores prompt artifacts");
  assert.ok(powershell.indexOf("$subagentsPatchCommitted = $true") > psTarget, "update.ps1: subagents guard must own its snapshot after target validation");
  assert.ok(shell.indexOf("SUBAGENTS_PATCH_COMMITTED=1") > shTarget, "update.sh: subagents guard must own its snapshot after target validation");
  const subagentsPatch = fs.readFileSync(path.join(repoRoot, "lib", "pui-subagents-patch.js"), "utf8");
  assert.match(subagentsPatch, /command === "guard-snapshot"/, "subagents guard exposes the guard-snapshot command");
  assert.match(subagentsPatch, /writeFileSync\(path\.join\(stateDir, "guard-ready"\)/, "subagents guard writes its ready marker");
});

test("staged apply rechecks Pi Web idle immediately before stopping the server", () => {
  const powershell = read("update.ps1");
  assert.ok(powershell.indexOf("/api/agent/running") < powershell.indexOf("Stop-Process"));

  const shell = read("update.sh");
  const idle = shell.indexOf("/api/agent/running");
  for (const stop of ['launchctl unload "$PLIST"', 'systemctl --user stop "$SERVICE_NAME"', "pkill -f '[/]node_modules[/]@agegr[/]pi-web[/]'"]) {
    assert.ok(idle < shell.indexOf(stop), `update.sh: idle check must precede ${stop}`);
  }
});

test("staged apply verifies Pi Web is actually stopped before mutating the global package", () => {
  const powershell = read("update.ps1");
  const psStop = powershell.indexOf("Stop-Process");
  const psAbort = powershell.indexOf("could not stop Pi Web");
  const psInstall = powershell.indexOf("updating @agegr/pi-web...");
  assert.ok(psStop !== -1 && psAbort > psStop, "update.ps1: stop verification must follow the stop attempt");
  assert.ok(psAbort !== -1 && psAbort < psInstall, "update.ps1: must abort before the pi-web npm install when Pi Web is still running");
  assert.match(powershell, /Get-NetTCPConnection/, "update.ps1: port-listener fallback covers WMI enumeration misses");

  const shell = read("update.sh");
  const shStop = shell.indexOf("pkill -f '[/]node_modules[/]@agegr[/]pi-web[/]'");
  const shAbort = shell.indexOf("could not stop Pi Web");
  const shInstall = shell.indexOf('echo "  updating @agegr/pi-web..."');
  assert.ok(shStop !== -1 && shAbort > shStop, "update.sh: stop verification must follow pkill");
  assert.ok(shAbort !== -1 && shAbort < shInstall, "update.sh: must abort before the pi-web npm install when Pi Web is still running");
});

test("updater process helpers never spawn visible console windows on Windows", () => {
  const updater = fs.readFileSync(path.join(repoRoot, "lib", "pui-updater.js"), "utf8");
  const spawnLines = updater.split(/\r?\n/).filter((line) => line.includes("spawnSync("));
  assert.ok(spawnLines.length > 0, "expected spawnSync call sites in pui-updater.js");
  for (const line of spawnLines) assert.match(line, /windowsHide:\s*true/, line.trim());
});

test("staged apply requires stable Windows Pi Web health after restart", () => {
  const powershell = read("update.ps1");
  assert.match(powershell, /function Wait-PiWebStopped/, "update.ps1: restart must verify the old process is gone");
  assert.match(powershell, /function Wait-PiWebHealthy/, "update.ps1: restart must use a shared health gate");
  assert.match(powershell, /StatusCode -eq 200/, "update.ps1: health gate must require HTTP 200");
  assert.match(powershell, /-ErrorAction Stop/, "update.ps1: health failures must be catchable");

  const restart = powershell.indexOf("restarting pi-web");
  const restartStop = powershell.indexOf("foreach ($pidToStop in @(Get-PiWebPid))", restart);
  const restartLaunch = powershell.indexOf('Start-Process -FilePath "wscript.exe"', restartStop);
  const stopGate = powershell.indexOf("Wait-PiWebStopped", restartStop);
  const healthGate = powershell.indexOf("Wait-PiWebHealthy", restartLaunch);
  assert.ok(restartStop !== -1 && stopGate > restartStop && stopGate < restartLaunch, "update.ps1: restart must wait for Pi Web to stop before launch");
  assert.ok(restartLaunch !== -1 && healthGate > restartLaunch, "update.ps1: stable health gate must follow the restart");
  assert.match(powershell, /pi-web launch requested via autostart launcher/);
  assert.match(powershell, /pi-web restarted via autostart launcher and is running and healthy/);

  const doctor = read("doctor.ps1");
  assert.match(doctor, /Invoke-WebRequest \$piWebUrl -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop/, "doctor.ps1: health failures must be terminating and catchable");
  assert.match(doctor, /StatusCode -eq 200/, "doctor.ps1: health check must require HTTP 200");
});

test("staged apply restarts Pi Web through the autostart launcher and gates on health", () => {
  const powershell = read("update.ps1");
  assert.match(powershell, /wscript\.exe/, "update.ps1: restart must go through the hidden VBS launcher");
  assert.match(powershell, /Get-PiWebPid/, "update.ps1: restart stop must reuse the hardened pi-web detection");
  const restart = powershell.indexOf("restarting pi-web");
  const healthGate = powershell.indexOf("HTTP 200 within 60s");
  const smokeSuite = powershell.indexOf("running smoke suite");
  assert.ok(restart !== -1 && restart < healthGate, "update.ps1: health gate must follow the restart");
  assert.ok(healthGate !== -1 && healthGate < smokeSuite, "update.ps1: health gate must precede the smoke suite");

  const shell = read("update.sh");
  assert.match(shell, /HTTP 200 within 60s/, "update.sh: restart must stay health-gated");
});

test("installers refuse to replace shared runtimes without both idle gates", () => {
  for (const file of ["install.ps1", "install.sh"]) {
    const content = read(file);
    const piWebIdle = content.indexOf("/api/agent/running");
    const stop = file.endsWith(".ps1") ? content.indexOf("Stop-Process") : content.indexOf("if ! stop_existing_piweb_autostart");
    const standalone = content.indexOf("standalone-busy");
    const mutation = file.endsWith(".ps1")
      ? content.indexOf('Invoke-Npm -NpmArgs @("install"', stop)
      : content.indexOf("npm install -g", stop);
    assert.ok(piWebIdle !== -1 && piWebIdle < stop, `${file}: Pi Web idle gate`);
    assert.ok(standalone !== -1 && stop < standalone && standalone < mutation, `${file}: standalone Pi idle gate`);
  }
});

test("staged apply rechecks standalone Pi after stopping Pi Web and before package mutation", () => {
  for (const file of ["update.ps1", "update.sh"]) {
    const content = read(file);
    const stop = file.endsWith(".ps1") ? content.indexOf("Stop-Process") : content.indexOf("pkill -f '[/]node_modules[/]@agegr[/]pi-web[/]'");
    const standalone = content.indexOf("standalone-busy");
    const mutation = content.indexOf("npm install -g", stop);
    assert.ok(stop < standalone && standalone < mutation, file);
  }
});

test("uninstall preserves a Playwright entry with user-modified lifecycle or direct tools", () => {
  for (const file of ["uninstall.ps1", "uninstall.sh"]) {
    const content = read(file);
    assert.match(content, /lifecycle/);
    assert.match(content, /directTools/);
  }
});

test("uninstall preserves drifted autostart entries and removes only canonical entries", () => {
  const shell = read("uninstall.sh");
  assert.match(shell, /cmp -s|diff -q/, "uninstall.sh: exact content comparison");
  assert.match(shell, /LaunchAgent.*differs|LaunchAgent.*preserving|preserving.*LaunchAgent/i);
  assert.match(shell, /systemd.*differs|systemd.*preserving|preserving.*systemd/i);
  assert.match(shell, /pui-piweb\.service/);

  const powershell = read("uninstall.ps1");
  assert.match(powershell, /Get-Content[\s\S]*vbsContent|ReadAllText[\s\S]*launcherVbs/);
  assert.match(powershell, /launcher.*differs|launcher.*preserving|preserving.*launcher/i);
  assert.match(powershell, /pui-piweb\.bat/);
  assert.match(powershell, /complete canonical|exact.*shape|canonical/i);
});

test("doctor treats missing or drifted MCP footer status as a failure with detail", () => {
  for (const file of ["doctor.sh", "doctor.ps1"]) {
    const content = read(file);
    const footer = content.indexOf("MCP footer status");
    assert.notEqual(footer, -1, `${file}: footer status diagnostic`);
    const section = content.slice(Math.max(0, footer - 500), footer + 500);
    assert.match(section, /FAIL/);
    assert.match(section, /does not match stack\.json|mismatch|missing/i);
  }
});

test("doctor verifies the installed Pi Web runtime instead of its dependency declaration", () => {
  for (const file of ["doctor.sh", "doctor.ps1"]) {
    const content = read(file);
    assert.match(content, /pi-web[\s\S]*node_modules[\s\S]*pi-coding-agent[\s\S]*package\.json/, file);
  }
  assert.doesNotMatch(read("doctor.sh"), /dependencies.*pi-coding-agent/);
  assert.doesNotMatch(read("doctor.ps1"), /dependencies\.'@earendil-works\/pi-coding-agent'/);
});

test("Unix install always stops a detected Pi Web process before package mutation", () => {
  const install = read("install.sh");
  const stopPhase = install.slice(install.indexOf("stop_existing_piweb_autostart"), install.indexOf("standalone-busy"));
  assert.doesNotMatch(stopPhase, /if has_cmd pi-web/);
  assert.match(stopPhase, /pkill -f/);
  assert.match(stopPhase, /pgrep -f[\s\S]*install aborted/);
});

test("uninstall backs up MCP JSON before removing its owned server", () => {
  for (const file of ["uninstall.sh", "uninstall.ps1"]) {
    const content = read(file);
    const removal = content.slice(content.indexOf("removing PUI-managed 'playwright'"));
    assert.match(removal.slice(0, 700), /backup/);
    assert.match(removal.slice(0, 700), /remove-server/);
  }
});

test("MCP lifecycle paths apply and verify the hybrid Playwright tool policy", () => {
  for (const file of ["install.ps1", "install.sh", "update.ps1", "update.sh", "doctor.ps1", "doctor.sh"]) {
    const content = read(file);
    assert.match(content, /directTools/, `${file}: direct tools`);
  }
  for (const file of ["install.ps1", "install.sh", "doctor.ps1", "doctor.sh"]) {
    assert.match(read(file), /disableProxyTool/, `${file}: disabled proxy detection`);
  }
});

test("Windows install and update fail when a JSON backup fails", () => {
  const install = read("install.ps1");
  assert.match(install, /Invoke-NodeConfig -CfgArgs @\("backup", \$f\)[\s\S]*?\.exit -ne 0[\s\S]*?\$g2 = \$false/);

  const update = read("update.ps1");
  assert.match(update, /node \$Lib "backup" \$f[\s\S]*?\$LASTEXITCODE[\s\S]*?-ne 0[\s\S]*?exit 1/);
});

test("installers and updaters treat branding and icon failures as fatal", () => {
  for (const file of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = read(file);
    assert.doesNotMatch(content, /WARNING: (?:icon|text branding)|branding override skipped|icon override skipped/);
  }
});

test("CI runs the complete test suite and fails PowerShell parse errors", () => {
  const workflow = read(".github/workflows/tests.yml");
  assert.doesNotMatch(workflow, /node --test tests\/pui-config\.test\.js/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /throw .*Parse/i);
  // "$f:" is parsed by PowerShell as a drive-qualified variable and aborts
  // the workflow step before the parse check runs; use "${f}" instead.
  assert.doesNotMatch(workflow, /\$\w+:/);
});

test("Unix lifecycle scripts propagate autostart registration and restart failures", () => {
  const install = read("install.sh");
  assert.doesNotMatch(install, /launchctl load "\$PLIST"[^\n]*\|\| true/);
  assert.doesNotMatch(install, /systemctl --user (?:daemon-reload|enable "\$SERVICE_NAME")[^\n]*\|\| true/);

  const update = read("update.sh");
  assert.doesNotMatch(update, /launchctl load "\$PLIST"[^\n]*\|\| true/);
  assert.doesNotMatch(update, /systemctl --user (?:daemon-reload|restart pui-piweb)[^\n]*\|\| true/);
});

test("macOS LaunchAgents inherit the active Pi Web and Node bin directory", () => {
  for (const file of ["install.sh", "update.sh"]) {
    const content = read(file);
    assert.match(content, /PIWEB_PATH=.*dirname "\$PIWEB_BIN"/);
    assert.match(content, /<key>PATH<\/key><string>\$PIWEB_PATH<\/string>/);
  }
});

test("Unix installer leaves Pi Web startup to exactly one service manager", () => {
  const install = read("install.sh");
  const phase = install.slice(install.indexOf("# ---- Phase 8"), install.indexOf("# ---- Phase 9"));

  assert.doesNotMatch(phase, /PI_WEB_SKIP_VERSION_CHECK=1 pi-web --no-open/);
  assert.doesNotMatch(phase, /PIWEB_(?:PID|LOG)/);
  assert.equal((phase.match(/launchctl load "\$PLIST"/g) || []).length, 1);
  assert.equal((phase.match(/systemctl --user restart "\$SERVICE_NAME"/g) || []).length, 1);
});

test("Unix autostart validates the managed service and HTTP endpoint", () => {
  for (const file of ["install.sh", "update.sh"]) {
    const content = read(file);
    assert.match(content, /launchctl print .*PLIST_LABEL/);
    assert.match(content, /state = running/);
    assert.match(content, /systemctl --user is-active --quiet/);
    assert.match(content, /curl -sf --max-time 5 "\$PIWEB_URL"/);
  }
});

test("macOS LaunchAgents restart Pi Web after unsuccessful exits", () => {
  const restartOnFailure = /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/;
  for (const file of ["install.sh", "update.sh"]) {
    const content = read(file);
    assert.match(content, restartOnFailure);
    assert.doesNotMatch(content, /<key>KeepAlive<\/key><false\/>/);
  }
});

test("Unix lifecycle managers are stopped before Pi Web package mutation", () => {
  for (const file of ["install.sh", "update.sh"]) {
    const content = read(file);
    const packageStop = content.indexOf("pkill -f '[/]node_modules[/]@agegr[/]pi-web[/]'");
    assert.notEqual(packageStop, -1);
    assert.ok(content.indexOf('launchctl unload "$PLIST"') < packageStop);
    assert.ok(content.indexOf('systemctl --user stop "$SERVICE_NAME"') < packageStop);
  }
});

test("Linux autostart starts immediately and inherits the Pi Web Node path", () => {
  const install = read("install.sh");
  assert.match(install, /has_cmd curl/);
  assert.match(install, /has_cmd systemctl/);

  for (const file of ["install.sh", "update.sh"]) {
    const content = read(file);
    assert.match(content, /Environment="PATH=\$PIWEB_PATH"/);
    assert.match(content, /ExecStart="\$PIWEB_BIN" --no-open/);
  }
});

test("Unix doctor distinguishes autostart registration from runtime state", () => {
  const doctor = read("doctor.sh");
  assert.match(doctor, /autostart registration/);
  assert.match(doctor, /autostart runtime/);
  assert.match(doctor, /launchctl print/);
  assert.match(doctor, /state = running/);
  assert.match(doctor, /systemctl --user is-active --quiet/);
  assert.doesNotMatch(doctor, /launchctl list/);
});

test("doctor scripts do not advertise an unimplemented repair mode", () => {
  for (const file of ["doctor.ps1", "doctor.sh"]) {
    assert.doesNotMatch(read(file), /(?:--fix|-Fix)|not implemented/i);
  }
});

test("full uninstall stops Pi Web before removing its global package", () => {
  const powershell = read("uninstall.ps1");
  const stopIndex = powershell.indexOf("Stop-Process");
  const uninstallIndex = powershell.indexOf('npm uninstall -g "@agegr/pi-web"');
  assert.notEqual(stopIndex, -1);
  assert.ok(stopIndex < uninstallIndex);

  const shell = read("uninstall.sh");
  assert.doesNotMatch(shell, /npm uninstall -g "@agegr\/pi-web"[^\n]*\|\| true/);
  assert.doesNotMatch(shell, /npm uninstall -g "@earendil-works\/pi-coding-agent"[^\n]*\|\| true/);
});

test("uninstall completion text does not claim Pi remains after full removal", () => {
  for (const file of ["uninstall.ps1", "uninstall.sh"]) {
    assert.doesNotMatch(read(file), /uninstall complete[^\n]*Pi installation remains/i);
  }
});

test("Windows VBS autostart launcher is written without a UTF-8 BOM", () => {
  // Windows Script Host cannot parse UTF-8 with BOM: the EF BB BF prefix
  // surfaces as "Invalid character" (800A0408) at line 1, char 1 on login.
  for (const file of ["install.ps1", "update.ps1"]) {
    const content = read(file);
    assert.doesNotMatch(content, /WriteAllText\(\$launcherVbs[^)]*\$true\)/);
    assert.match(content, /WriteAllText\(\$launcherVbs[^)]*UTF8Encoding]::new\(\$false\)\)/);
  }
});

test("lifecycle scripts stop only the installed Pi Web package", () => {
  for (const file of ["install.sh", "update.sh"]) {
    assert.doesNotMatch(read(file), /pkill -f "pi-web"/);
  }
  for (const file of ["install.ps1", "update.ps1", "uninstall.ps1"]) {
    const content = read(file);
    assert.match(content, /node_modules.*@agegr.*pi-web/);
  }
});
