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

test("both staged apply paths expose the same material failure-injection boundaries", () => {
  const boundaries = ["package-reconciliation", "config-migration", "pi-web-integration", "extension-replacement", "restart-health", "target-validation"];
  for (const file of ["update.ps1", "update.sh"]) {
    const content = read(file);
    for (const boundary of boundaries) assert.match(content, new RegExp(boundary), `${file}: ${boundary}`);
  }
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

test("MCP lifecycle paths apply and verify the hybrid Playwright tool policy", () => {
  for (const file of ["install.ps1", "install.sh", "update.ps1", "update.sh", "doctor.ps1", "doctor.sh"]) {
    const content = read(file);
    assert.match(content, /directTools/, `${file}: direct tools`);
  }
  for (const file of ["install.ps1", "install.sh", "doctor.ps1", "doctor.sh"]) {
    assert.match(read(file), /disableProxyTool/, `${file}: disabled proxy detection`);
  }
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
