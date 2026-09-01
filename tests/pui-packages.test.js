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
  assert.equal(stack.piPackages.some((spec) => /ogul|compaction/i.test(spec)), false);
});

test("PUI owns subagent taxonomy, capabilities, completion delivery, model mapping, and reasoning inheritance", () => {
  assert.deepEqual(stack.subagentsPromptPatch, {
    schemaVersion: 1,
    revision: 11,
    packagePath: "node_modules/@gotgenes/pi-subagents",
    files: [
      "src/tools/agent-tool.ts",
      "src/session/prompts.ts",
      "src/config/default-agents.ts",
      "src/config/agent-types.ts",
      "src/config/invocation-config.ts",
      "src/tools/spawn-config.ts",
      "src/runtime.ts",
      "src/types.ts",
      "src/observation/notification.ts",
      "src/index.ts",
      "src/settings.ts",
      "src/lifecycle/concurrency-limiter.ts",
      "src/lifecycle/subagent-manager.ts",
    ],
    backupSuffix: ".pui-original",
    manifest: ".pui-subagents-prompt-manifest.json",
  });
  assert.equal(stack.configPaths.puiSubagents, "~/.config/pui/subagents.json");
  assert.deepEqual(stack.subagents, {
    schemaVersion: 1,
    maxConcurrent: 128,
    maxQueued: 512,
    modelMappings: {
      "openai-codex/gpt-5.6-sol": "openai-codex/gpt-5.6-luna",
    },
  });
  assert.equal(fs.existsSync(path.join(repoRoot, "lib", "pui-subagents-patch.js")), true);
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pui-subagents-patch\.js/, `${script}: subagent prompt patch`);
    assert.match(content, /subagents policy (?:applied|patch)/i, `${script}: subagent policy status`);
  }
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /reconcile-model-mappings/, `${script}: append missing shipped mappings`);
    assert.match(content, /puiSubagents/, `${script}: user config path`);
  }
  for (const script of ["doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /subagent policy/i, `${script}: subagent policy verification`);
    assert.match(content, /validate-model-mappings/, `${script}: user mapping validation`);
  }
  for (const script of ["uninstall.ps1", "uninstall.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pui-subagents-patch\.js/, `${script}: subagent prompt helper`);
    assert.match(content, /pui-subagents-patch\.js"|\$subagentsPatch/, `${script}: owned prompt restoration`);
  }
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

test("PUI manages compact structured-question guidance", () => {
  assert.equal(stack.configPaths.askUserQuestion, "~/.config/rpiv-ask-user-question/config.json");
  assert.deepEqual(stack.askUserQuestion, {
    configRelativePath: "rpiv-ask-user-question/config.json",
    guidance: {
      description: "Ask structured questions and wait for a response. Use when requested, or for a material choice genuinely owned by the user and unresolved by the request or available context. Decide delegated technical judgments and low-risk reversible details without asking. Free-text input is automatic; do not author \"Other\", \"Type something.\", or \"Next\" options. If recommending an option, list it first and append \"(Recommended)\". Use preview only for single-select visual comparisons.",
      promptSnippet: "Ask structured questions when requested or for unresolved material user-owned choices",
      promptGuidelines: [
        "When using ask_user_question, combine independent questions into one invocation, up to four questions per call; ask dependent questions only after earlier answers.",
      ],
    },
  });
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /askUserQuestion/, `${script}: stack guidance reference`);
    assert.match(content, /set-owned-fields/, `${script}: exact guidance reconciliation`);
    assert.match(content, /resolve-config-path[\s\S]{0,500}?(?:exit 1|\{[^}]*exit 1)/, `${script}: resolution failure aborts with a message`);
  }
  for (const script of ["install.sh", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /remove-array-items[\s\S]{0,120}?\|\| \{[^}]*exit 1/, `${script}: retired feature removal failure aborts with a message`);
    assert.match(content, /merge-object "\$PI_FFF_FEATURES"[\s\S]{0,80}?\|\| \{[^}]*exit 1/, `${script}: fff merge failure aborts with a message`);
  }
  for (const script of ["doctor.ps1", "doctor.sh"]) {
    assert.match(fs.readFileSync(path.join(repoRoot, script), "utf8"), /ask-user-question guidance/i, `${script}: guidance check`);
  }
  for (const script of ["uninstall.ps1", "uninstall.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /askUserQuestion/, `${script}: stack guidance reference`);
    assert.match(content, /config-candidate-paths/, `${script}: XDG and legacy ownership paths`);
    assert.match(content, /remove-owned-fields/, `${script}: exact ownership removal`);
    assert.match(content, /preserving \(user-owned\)/, `${script}: drift preservation`);
  }
});

test("PUI configures pi-fff feature state without custom agent tools", () => {
  assert.deepEqual(stack.fff.enabledFeatures, [
    "autocomplete",
    "builtInReadEnhancement",
    "builtInGrepEnhancement",
  ]);
  assert.deepEqual(stack.fff.retiredFeatures, ["agentTools"]);
  assert.equal(stack.fff.enabledFeatures.includes("agentTools"), false);
  assert.equal(stack.fff.enabledFeatures.includes("statusUI"), false);
  assert.equal(stack.configPaths.piFffFeatures, "~/.pi/agent/extensions/pi-fff.json");
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /piFffFeatures/, `${script}: piFffFeatures config path`);
    assert.match(content, /fff\.enabledFeatures/, `${script}: fff.enabledFeatures reference`);
    assert.match(content, /fff\.retiredFeatures/, `${script}: fff.retiredFeatures reference`);
    assert.match(content, /merge-object/, `${script}: merge-object call`);
    assert.match(content, /remove-array-items/, `${script}: retired feature removal`);
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
  assert.equal(stack.mcp.footerStatus, "off");
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /mcp\.footerStatus/, `${script}: stack-owned footer status`);
    assert.match(content, /mcpFooterStatus/, `${script}: mcpFooterStatus setting`);
    assert.match(content, /merge-object/, `${script}: merge-object call`);
  }
  for (const script of ["doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /mcp\.footerStatus/, `${script}: stack-owned footer status`);
    assert.match(content, /mcpFooterStatus/, `${script}: mcpFooterStatus check`);
  }
});

test("PUI manages background tasks, compact model guidance, and node-pty", () => {
  assert.deepEqual(stack.upstream.backgroundTasks, {
    npm: "@99percentpeople/pi-background-tasks",
    version: "2.1.1",
    repository: "https://github.com/99percentpeople/pi-extensions/tree/master/extensions/background-tasks",
  });
  assert.deepEqual(stack.backgroundTasksPromptPatch, {
    schemaVersion: 1,
    revision: 1,
    packagePath: "node_modules/@99percentpeople/pi-background-tasks",
    bundle: "index.min.js",
    backupSuffix: ".pui-original",
    manifestSuffix: ".pui-manifest.json",
  });
  assert.equal(stack.piPackages.includes("npm:@99percentpeople/pi-background-tasks@2.1.1"), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "lib", "pui-background-tasks-patch.js")), true);
  for (const script of ["install.ps1", "install.sh", "update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pi-background-tasks/, `${script}: pi-background-tasks reference`);
    assert.match(content, /pui-background-tasks-patch\.js/, `${script}: compact prompt patch`);
    assert.match(content, /node-pty/, `${script}: node-pty handling`);
    if (script.endsWith("install.ps1")) {
      assert.match(content, /if \(\$backgroundPatchExit -ne 0\) \{[^}]*\$g4 = \$false/s, `${script}: prompt patch failure fails G4`);
      assert.match(content, /if \(\$nativeExit -ne 0\) \{[^}]*\$g4 = \$false/s, `${script}: native failure fails G4`);
    }
    if (script.endsWith("install.sh")) {
      assert.match(content, /pui-background-tasks-patch\.js" apply[\s\S]{0,300}?G4=0/, `${script}: prompt patch failure fails G4`);
      assert.match(content, /pui-native-check\.js" ensure[\s\S]{0,300}?G4=0/, `${script}: native failure fails G4`);
    }
  }
  for (const script of ["update.ps1", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pui-background-tasks-patch\.js/, `${script}: compact prompt patch`);
    assert.match(content, /pui-native-check\.js/, `${script}: pui-native-check.js invocation`);
    if (script.endsWith("update.ps1")) {
      assert.match(content, /if \(\$backgroundPatchExit -ne 0\) \{[^}]*exit 1/s, `${script}: prompt patch failure aborts update`);
      assert.match(content, /if \(\$nativeExit -ne 0\) \{[^}]*exit 1/s, `${script}: native failure aborts update`);
    }
    if (script.endsWith("update.sh")) {
      assert.match(content, /(?:pui-background-tasks-patch\.js|BACKGROUND_PATCH)" apply[\s\S]{0,300}?exit 1/, `${script}: prompt patch failure aborts update`);
      assert.match(content, /pui-native-check\.js" ensure[\s\S]{0,300}?exit 1/, `${script}: native failure aborts update`);
    }
  }
  for (const script of ["doctor.ps1", "doctor.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pi-background-tasks prompt/, `${script}: prompt patch verification`);
    assert.match(content, /pi-background-tasks native/, `${script}: node-pty native status check`);
  }
  for (const script of ["uninstall.ps1", "uninstall.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pui-background-tasks-patch\.js/, `${script}: prompt patch helper`);
    assert.match(content, /(?:pui-background-tasks-patch\.js"|\$backgroundPatch) remove/, `${script}: owned prompt restoration`);
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
