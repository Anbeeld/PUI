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
    "npm:pi-mcp-adapter@2.29.0",
    "npm:@narumitw/pi-goal@0.54.3",
    "npm:@narumitw/pi-accounts@0.49.11",
    "npm:@narumitw/pi-usage@0.52.3",
    "npm:@juicesharp/rpiv-ask-user-question@2.7.1",
    "npm:pi-fff@0.1.12",
    "npm:@99percentpeople/pi-background-tasks@2.1.1",
  ]);
  assert.deepEqual(stack.retiredPiPackages, ["npm:@sting8k/pi-vcc"]);
  assert.equal("compaction" in stack.upstream, false);
  assert.equal("piVcc" in stack.configPaths, false);
});

test("PUI manages named OAuth accounts", () => {
  assert.deepEqual(stack.upstream.accounts, {
    npm: "@narumitw/pi-accounts",
    version: "0.49.11",
    repository: "https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-accounts",
  });
  for (const script of ["install.ps1", "install.sh", "doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pi-accounts/, `${script}: pi-accounts`);
  }
});

test("PUI manages usage tracking", () => {
  assert.deepEqual(stack.upstream.usage, {
    npm: "@narumitw/pi-usage",
    version: "0.52.3",
    repository: "https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-usage",
  });
  for (const script of ["install.ps1", "install.sh", "doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pi-usage/, `${script}: pi-usage`);
  }
});

test("PUI manages structured questions and fuzzy file search", () => {
  assert.deepEqual(stack.upstream.askUserQuestion, {
    npm: "@juicesharp/rpiv-ask-user-question",
    version: "2.7.1",
    repository: "https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question",
  });
  assert.deepEqual(stack.upstream.fuzzyFileFinder, {
    npm: "pi-fff",
    version: "0.1.12",
    repository: "https://github.com/ShpetimA/pi-fff",
  });
  for (const script of ["install.ps1", "install.sh", "doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    for (const packageName of ["rpiv-ask-user-question", "pi-fff"]) {
      assert.match(content, new RegExp(packageName), `${script}: ${packageName}`);
    }
    assert.doesNotMatch(content, /pi-permission-system/, `${script}: removed package`);
  }
  assert.equal(Object.hasOwn(stack.upstream, "permissionSystem"), false);
});

test("PUI configures pi-fff feature state to suppress startup notices", () => {
  assert.deepEqual(stack.fff.enabledFeatures, [
    "autocomplete",
    "builtInReadEnhancement",
    "builtInGrepEnhancement",
    "agentTools",
  ]);
  assert.equal(stack.fff.enabledFeatures.includes("statusUI"), false);
  assert.equal(stack.configPaths.piFffFeatures, "~/.pi/agent/extensions/pi-fff.json");
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /piFffFeatures/, `${script}: piFffFeatures config path`);
    assert.match(content, /fff\.enabledFeatures/, `${script}: fff.enabledFeatures reference`);
    assert.match(content, /merge-object/, `${script}: merge-object call`);
    assert.match(content, /startup notices/, `${script}: startup notices message`);
  }
  for (const script of ["doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /piFffFeatures/, `${script}: piFffFeatures config path`);
    assert.match(content, /fff feature state/, `${script}: fff feature state check`);
  }
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

test("PUI configures pi-goal for unlimited turns and a readable status line", () => {
  assert.equal(stack.configPaths.piGoal, "~/.pi/agent/pi-goal.json");
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /piGoal/, `${script}: piGoal config path`);
    assert.match(content, /continuationLimits/, `${script}: continuationLimits reference`);
    assert.match(content, /pui-goal-patch\.js/, `${script}: pui-goal-patch.js invocation`);
    assert.match(content, /automaticTurns/, `${script}: automaticTurns reference`);
  }
  for (const script of ["doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /piGoal/, `${script}: piGoal config path`);
    assert.match(content, /pi-goal status patch/, `${script}: patch verification`);
  }
});

test("PUI hides the MCP footer status from the extension bar", () => {
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /mcpFooterStatus/, `${script}: mcpFooterStatus setting`);
    assert.match(content, /merge-object/, `${script}: merge-object call`);
  }
  for (const script of ["doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /mcpFooterStatus/, `${script}: mcpFooterStatus check`);
  }
});

test("PUI manages background tasks and its node-pty native dependency", () => {
  assert.deepEqual(stack.upstream.backgroundTasks, {
    npm: "@99percentpeople/pi-background-tasks",
    version: "2.1.1",
    repository: "https://github.com/99percentpeople/pi-extensions/tree/master/extensions/background-tasks",
  });
  assert.equal(stack.piPackages.includes("npm:@99percentpeople/pi-background-tasks@2.1.1"), true);
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pi-background-tasks/, `${script}: pi-background-tasks reference`);
    assert.match(content, /node-pty/, `${script}: node-pty handling`);
    if (script.endsWith("install.ps1")) {
      assert.match(content, /if \(\$nativeExit -ne 0\) \{[^}]*\$g4 = \$false/s, `${script}: native failure fails G4`);
    }
    if (script.endsWith("install.sh")) {
      assert.match(content, /pui-native-check\.js" ensure[\s\S]*G4=0/, `${script}: native failure fails G4`);
    }
  }
  for (const script of ["update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pi-background-tasks/, `${script}: pi-background-tasks reference`);
    assert.match(content, /pui-native-check\.js/, `${script}: pui-native-check.js invocation`);
    assert.match(content, /node-pty/, `${script}: node-pty handling`);
    if (script.endsWith("update.ps1")) {
      assert.match(content, /if \(\$nativeExit -ne 0\) \{[^}]*exit 1/s, `${script}: native failure aborts update`);
    }
    if (script.endsWith("update.sh")) {
      assert.match(content, /pui-native-check\.js" ensure[\s\S]*exit 1/, `${script}: native failure aborts update`);
    }
  }
  for (const script of ["doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pi-background-tasks/, `${script}: pi-background-tasks check`);
    assert.match(content, /pi-background-tasks native/, `${script}: node-pty native status check`);
  }
});

test("Playwright exposes six common tools directly and keeps proxy discovery enabled", () => {
  assert.deepEqual(stack.mcp.directTools, [
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_wait_for",
    "browser_take_screenshot",
  ]);
  assert.equal(Object.hasOwn(stack.mcp, "disableProxyTool"), false);
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
