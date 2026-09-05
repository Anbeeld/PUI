const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "..");
const {
  compareVersions,
  loadRelease,
  resolveUpgradeRoute,
  validateRelease,
} = require(path.join(repoRoot, "lib", "pui-release.js"));

test("the repository release pins every managed direct component", () => {
  const release = loadRelease(repoRoot);
  assert.deepEqual(validateRelease(release), []);
  assert.equal(release.version, "1.3.0");
  assert.equal(release.stack.reasoningSummaryPatch.revision, 17, "v1.3.0 must refresh the selected session live for session_info_changed");
  assert.deepEqual(release.stack.skillLoaderExtension, {
    schemaVersion: 1,
    target: "~/.pi/agent/extensions/pui-skill-loader",
    files: ["core.ts", "index.ts", "package.json", "pui-extension-transaction.cjs"],
    manifest: "manifest.json",
  });
  assert.deepEqual(release.stack.reasoningSummaryExtension, {
    schemaVersion: 1,
    target: "~/.pi/agent/extensions/pui-reasoning-summary",
    files: ["core.ts", "index.ts", "package.json"],
    manifest: "manifest.json",
  });
  assert.deepEqual(release.stack.sessionTitleExtension, {
    schemaVersion: 1,
    target: "~/.pi/agent/extensions/pui-session-title",
    files: ["core.ts", "index.ts", "package.json"],
    manifest: "manifest.json",
  });
  assert.deepEqual(release.stack.sessionTitles, { schemaVersion: 1, models: [] });
  assert.deepEqual(release.stack.reasoningSummaries.modelModes, {
    "gpt-5.6-sol": "detailed",
    "gpt-5.6-terra": "detailed",
    "gpt-5.6-luna": "detailed",
  });
  for (const spec of Object.values(release.managed)) {
    assert.match(spec, /@\d+\.\d+\.\d+$/);
    assert.doesNotMatch(spec, /@latest$/);
  }
});

test("release validation rejects rolling managed versions", () => {
  const release = loadRelease(repoRoot);
  release.stack.upstream.gui.version = "latest";
  assert.match(validateRelease(release).join("\n"), /gui.*exact version/i);
  const mismatched = loadRelease(repoRoot);
  mismatched.stack.piPackages[0] = "npm:@gotgenes/pi-subagents@99.0.0";
  assert.match(validateRelease(mismatched).join("\n"), /piPackages.*upstream/i);
  const invalidPromptPatch = loadRelease(repoRoot);
  invalidPromptPatch.stack.backgroundTasksPromptPatch.bundle = "other.js";
  assert.match(validateRelease(invalidPromptPatch).join("\n"), /backgroundTasksPromptPatch.*bundle/i);
  const invalidSubagentsPatch = loadRelease(repoRoot);
  invalidSubagentsPatch.stack.subagentsPromptPatch.files = ["other.ts"];
  assert.match(validateRelease(invalidSubagentsPatch).join("\n"), /subagentsPromptPatch.*files/i);
  for (const files of [["src/../../outside.ts"], ["src/tools\\..\\..\\outside.ts"], ["src/tools/agent-tool.ts", "src/tools/agent-tool.ts"]]) {
    const unsafeSubagentsPatch = loadRelease(repoRoot);
    unsafeSubagentsPatch.stack.subagentsPromptPatch.files = files;
    assert.match(validateRelease(unsafeSubagentsPatch).join("\n"), /subagentsPromptPatch.*files/i);
  }
  const invalidSubagentsMapping = loadRelease(repoRoot);
  invalidSubagentsMapping.stack.subagents.modelMappings = { sol: 42 };
  assert.match(validateRelease(invalidSubagentsMapping).join("\n"), /subagents\.modelMappings.*string/i);
  for (const field of ["maxConcurrent", "maxQueued"]) {
    const invalidLimit = loadRelease(repoRoot);
    invalidLimit.stack.subagents[field] = 0;
    assert.match(validateRelease(invalidLimit).join("\n"), new RegExp(`subagents\\.${field}.*positive integer`, "i"));
  }
  for (const modelMappings of [{ " sol ": "luna" }, { Sol: "luna", sol: "terra" }]) {
    const ambiguousMappings = loadRelease(repoRoot);
    ambiguousMappings.stack.subagents.modelMappings = modelMappings;
    assert.match(validateRelease(ambiguousMappings).join("\n"), /subagents\.modelMappings/i);
  }
  const invalidReasoningModes = loadRelease(repoRoot);
  invalidReasoningModes.stack.reasoningSummaries.modelModes["gpt-5.6-sol"] = "verbose";
  assert.match(validateRelease(invalidReasoningModes).join("\n"), /reasoningSummaries\.modelModes/i);
  const invalidReasoningExtension = loadRelease(repoRoot);
  invalidReasoningExtension.stack.reasoningSummaryExtension.files = ["index.ts"];
  assert.match(validateRelease(invalidReasoningExtension).join("\n"), /reasoningSummaryExtension\.files/i);
  const invalidReasoningPath = loadRelease(repoRoot);
  invalidReasoningPath.stack.configPaths.puiReasoningSummaries = "~/.pi/other.json";
  assert.match(validateRelease(invalidReasoningPath).join("\n"), /puiReasoningSummaries/i);
  const invalidTitleModels = loadRelease(repoRoot);
  invalidTitleModels.stack.sessionTitles.models = ["luna", "LUNA"];
  assert.match(validateRelease(invalidTitleModels).join("\n"), /sessionTitles\.models/i);
  const invalidTitleExtension = loadRelease(repoRoot);
  invalidTitleExtension.stack.sessionTitleExtension.target = "~/.pi/agent/extensions/other";
  assert.match(validateRelease(invalidTitleExtension).join("\n"), /sessionTitleExtension/i);
  const invalidTitlePath = loadRelease(repoRoot);
  invalidTitlePath.stack.configPaths.puiSessionTitles = "~/.pi/other.json";
  assert.match(validateRelease(invalidTitlePath).join("\n"), /puiSessionTitles/i);

  const invalidFooter = loadRelease(repoRoot);
  invalidFooter.stack.mcp.footerStatus = "visible";
  assert.match(validateRelease(invalidFooter).join("\n"), /mcp\.footerStatus/i);
  const invalidSkillLoader = loadRelease(repoRoot);
  invalidSkillLoader.stack.skillLoaderExtension.target = "~/.pi/agent/extensions/other";
  assert.match(validateRelease(invalidSkillLoader).join("\n"), /skillLoaderExtension/i);
});

test("active releases require the Pi #8782 backport helper", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-backport-release-files-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const release = loadRelease(repoRoot);
  release.repoRoot = temp;
  const errors = validateRelease(release).join("\n");
  assert.match(errors, /missing required release file lib\/pui-pi-8782-backport\.js/);
  assert.match(errors, /missing required release file tests\/verify-pi-8782-backport\.js/);
});

test("release validation permits future prompt revisions with the stable ownership schema", () => {
  const future = loadRelease(repoRoot);
  future.version = "1.2.2";
  future.stack.backgroundTasksPromptPatch.revision = 3;
  future.stack.subagentsPromptPatch.revision = 5;
  assert.deepEqual(validateRelease(future), []);
});

test("reasoning-summary ownership starts with v1.2.0", () => {
  const historical = loadRelease(repoRoot);
  historical.version = "1.1.3";
  delete historical.stack.reasoningSummaryPatch;
  assert.deepEqual(validateRelease(historical), []);
});

test("release validation remains compatible with pre-patch historical releases", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-historical-release-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const historical = loadRelease(repoRoot);
  historical.version = "1.1.1";
  historical.repoRoot = temp;
  delete historical.stack.backgroundTasksPromptPatch;
  delete historical.stack.subagentsPromptPatch;
  const historicalFiles = [
    "install.ps1", "install.sh", "update.ps1", "update.sh", "doctor.ps1", "doctor.sh", "uninstall.ps1", "uninstall.sh",
    "lib/pui-updater.js", "lib/pui-update-extension.js", "lib/pui-web-integration.js", "lib/pui-update-bridge.cjs", "lib/pui-goal-patch.js", "lib/pui-native-check.js",
    "extensions/pui-update/index.ts", "assets/pui-update-client.js",
  ];
  for (const file of historicalFiles) {
    const target = path.join(temp, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "fixture");
  }

  assert.deepEqual(validateRelease(historical), []);
});

test("upgrade routes follow explicit checkpoints and reject cycles", async () => {
  const manifests = new Map([
    ["3.0.0", { version: "3.0.0", upgradeVia: "2.0.0" }],
    ["2.0.0", { version: "2.0.0", upgradeVia: "1.5.0" }],
    ["1.5.0", { version: "1.5.0" }],
  ]);
  const route = await resolveUpgradeRoute("1.0.0", "3.0.0", async (version) => manifests.get(version));
  assert.deepEqual(route, ["1.5.0", "2.0.0", "3.0.0"]);

  const alreadyPastCheckpoint = await resolveUpgradeRoute("2.1.0", "3.0.0", async (version) => manifests.get(version));
  assert.deepEqual(alreadyPastCheckpoint, ["3.0.0"]);

  manifests.set("1.5.0", { version: "1.5.0", upgradeVia: "3.0.0" });
  await assert.rejects(
    resolveUpgradeRoute("1.0.0", "3.0.0", async (version) => manifests.get(version)),
    /cycle/i,
  );
});

test("version comparison is monotonic", () => {
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.throws(() => compareVersions("latest", "1.0.0"), /semantic version/i);
});

test("CI validates release metadata and exact managed prompt artifacts", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "tests.yml"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(workflow, /npm run release:validate/);
  assert.match(workflow, /GITHUB_REF_TYPE/);
  assert.match(workflow, /package\.json/);
  assert.equal(packageJson.scripts["release:verify-prompt-patches"], "node tests/verify-prompt-patches.js");
  assert.match(workflow, /npm run release:verify-prompt-patches/);
  assert.equal(fs.existsSync(path.join(repoRoot, "tests", "verify-prompt-patches.js")), true);
  assert.equal(packageJson.scripts["release:verify-reasoning-summary"], "node tests/verify-reasoning-summary.js");
  assert.match(workflow, /npm run release:verify-reasoning-summary/);
  assert.equal(fs.existsSync(path.join(repoRoot, "tests", "verify-reasoning-summary.js")), true);
});
