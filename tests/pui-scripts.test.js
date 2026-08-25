const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");

test("all Unix entry points use the shared stack reader", () => {
  for (const file of ["install.sh", "update.sh", "uninstall.sh", "doctor.sh"]) {
    const content = read(file);
    assert.match(content, /lib\/pui-stack\.js/);
    assert.doesNotMatch(content, /process\.stdout\.write\(JSON\.stringify\(v\)\)/);
  }
});

test("Unix branding does not depend on platform-specific sed -i", () => {
  for (const file of ["install.sh", "update.sh"]) {
    assert.doesNotMatch(read(file), /sed -i/);
  }
});

test("updaters propagate extension and model update failures", () => {
  const shell = read("update.sh");
  assert.doesNotMatch(shell, /pi update --(?:extensions|models)[^\n]*\|\| true/);

  const powershell = read("update.ps1");
  assert.match(powershell, /extensionsExit/);
  assert.match(powershell, /modelsExit/);
});

test("uninstall preserves a Playwright entry with user-modified lifecycle", () => {
  for (const file of ["uninstall.ps1", "uninstall.sh"]) {
    const content = read(file);
    assert.match(content, /lifecycle/);
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

test("lifecycle scripts stop only the installed Pi Web package", () => {
  for (const file of ["install.sh", "update.sh"]) {
    assert.doesNotMatch(read(file), /pkill -f "pi-web"/);
  }
  for (const file of ["install.ps1", "update.ps1", "uninstall.ps1"]) {
    const content = read(file);
    assert.match(content, /node_modules.*@agegr.*pi-web/);
  }
});
