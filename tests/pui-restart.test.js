const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");

function unixRestart(t, platform, failure = "", managed = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-restart-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "calls");
  const scripts = {
    uname: `echo ${platform}`,
    node: `echo http://127.0.0.1:3141`,
    ps: "exit 0",
    lsof: "exit 0",
    sleep: "exit 0",
    curl: '[ "$FAILURE" != health ] && { [ "$MANAGED" = 1 ] || grep -q manual: "$CALLS" 2>/dev/null; }',
    "pi-web": 'echo "manual:$PI_WEB_SKIP_VERSION_CHECK:$*" >> "$CALLS"',
    nohup: '"$@"',
    systemctl: 'echo "systemctl:$*" >> "$CALLS"; if [ "$FAILURE" = stop ] && [ "$2" = stop ]; then exit 1; fi',
    launchctl: 'echo "launchctl:$*" >> "$CALLS"; if [ "$1" = print ]; then echo "state = running"; fi',
  };
  for (const [name, content] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${content}\n`, { mode: 0o755 });
  }
  const registration = platform === "Darwin"
    ? "Library/LaunchAgents/com.pui.piweb.plist"
    : ".config/systemd/user/pui-piweb.service";
  if (managed) {
    fs.mkdirSync(path.dirname(path.join(dir, registration)), { recursive: true });
    fs.writeFileSync(path.join(dir, registration), "fixture");
  }
  const shellPath = (value) => value.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  const result = spawnSync("bash", ["-c", 'export PATH="$MOCK_BIN:$PATH"; exec bash ./restart.sh'], {
    cwd: root, encoding: "utf8", timeout: 15000,
    env: { ...process.env, HOME: shellPath(dir), MOCK_BIN: shellPath(bin), CALLS: shellPath(log), FAILURE: failure, MANAGED: managed ? "1" : "0" },
  });
  if (managed) assert.equal(fs.readFileSync(path.join(dir, registration), "utf8"), "fixture");
  else assert.equal(fs.existsSync(path.join(dir, registration)), false);
  return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
}

for (const platform of ["Linux", "Darwin"]) {
  test(`restart uses existing ${platform} service without installing or rewriting it`, (t) => {
    const result = unixRestart(t, platform);
    assert.equal(result.status, 0, result.stderr);
    if (platform === "Linux") {
      assert.match(result.calls, /systemctl:--user stop pui-piweb/);
      assert.match(result.calls, /systemctl:--user start pui-piweb/);
    } else {
      assert.match(result.calls, /launchctl:unload .*com.pui.piweb.plist/);
      assert.match(result.calls, /launchctl:load .*com.pui.piweb.plist/);
    }
    assert.match(result.stdout, /healthy/);
  });
}
test("restart propagates service stop failure", (t) => {
  const result = unixRestart(t, "Linux", "stop");
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /--user start/);
});
test("restart fails when HTTP health never recovers", (t) => {
  const result = unixRestart(t, "Linux", "health");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /healthy/);
});
test("restart supports manual installs without creating autostart", (t) => {
  const result = unixRestart(t, "Linux", "", false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /manual:1:--no-open/);
  assert.doesNotMatch(result.calls, /systemctl/);
});

for (const failure of ["", "stop", "launch", "health"]) {
  test(`Windows restart: ${failure || "hidden launch and environment restored"}`, { skip: process.platform !== "win32" }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-restart-win-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "npm"));
    fs.writeFileSync(path.join(dir, "npm", "pi-web.cmd"), "fixture only");
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(__dirname, "fixtures", "restart-windows.ps1"),
      "-RepoRoot", root, "-FixtureRoot", dir, "-Failure", failure,
    ], { encoding: "utf8", timeout: 15000 });
    if (!failure) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /STOPPED/);
      assert.match(result.stdout, /VERIFIED/);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, failure === "stop" ? /fixture stop failure/ : failure === "launch" ? /Could not launch Pi Web/ : /did not become healthy/);
    }
  });
}
