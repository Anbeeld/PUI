const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const stack = require(path.join(repoRoot, "stack.json"));

test("PUI manages pi-goal and retires pi-vcc", () => {
  assert.equal(stack.upstream.goal.npm, "@narumitw/pi-goal");
  assert.equal(
    stack.upstream.goal.repository,
    "https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal",
  );
  assert.deepEqual(stack.piPackages, [
    "npm:@gotgenes/pi-subagents@19.3.5",
    "npm:pi-web-access@0.25.0",
    "npm:pi-mcp-adapter@2.27.0",
    "npm:@narumitw/pi-goal@0.54.0",
  ]);
  assert.deepEqual(stack.retiredPiPackages, ["npm:@sting8k/pi-vcc"]);
  assert.equal("compaction" in stack.upstream, false);
  assert.equal("piVcc" in stack.configPaths, false);
});

test("managed packages are exact and lifecycle scripts do not roll them forward", () => {
  for (const spec of stack.piPackages) assert.match(spec, /@\d+\.\d+\.\d+$/);
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.doesNotMatch(content, /@agegr\/pi-web@latest|pi-web@latest/);
  }
  for (const script of ["update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.doesNotMatch(content, /pi update --extensions/);
  }
});

test("all lifecycle entry points manage installed identity and Pi Web integration", () => {
  for (const script of ["install.ps1", "install.sh", "doctor.ps1", "doctor.sh", "uninstall.ps1", "uninstall.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pui-update-extension\.js/, script);
    assert.match(content, /pui-web-integration\.js/, script);
  }
});

test("install, update, and diagnostics migrate from pi-vcc to pi-goal", () => {
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /retiredPiPackages/);
    assert.match(content, /piPackages/);
  }
  for (const script of ["doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pi-goal/);
    assert.doesNotMatch(content, /pi-vcc|Pi VCC|piVcc/);
  }
});

test("full uninstall removes current and retired managed extensions", () => {
  for (const script of ["uninstall.ps1", "uninstall.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /retiredPiPackages/);
    assert.match(content, /piPackages/);
  }
});

test("fresh installs provision standalone Pi before requiring it on PATH", () => {
  const powershell = fs.readFileSync(path.join(repoRoot, "install.ps1"), "utf8");
  assert.ok(
    powershell.indexOf('"@earendil-works/pi-coding-agent@$piWebCodingAgentVer"') <
      powershell.indexOf("if (-not (Test-Command pi))"),
  );

  const shell = fs.readFileSync(path.join(repoRoot, "install.sh"), "utf8");
  assert.ok(
    shell.indexOf('npm install -g --ignore-scripts "$PI_SPEC"') <
      shell.indexOf('has_cmd pi || { echo "  pi not on PATH"'),
  );
});
