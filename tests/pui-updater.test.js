const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const installedVersion = require(path.join(repoRoot, "package.json")).version;
const {
  chooseStableUpdate,
  detachedSpawnOptions,
  backupBackgroundTaskFilesForStacks,
  backupSubagentFilesForStacks,
  backupConfigFiles,
  backupConfigFilesForStacks,
  backupSkillLoaderForStacks,
  backupReasoningSummaryExtensionForStacks,
  backupSessionTitleExtensionForStacks,
  backupSessionCommunicationExtensionForStacks,
  backupModelCatalogExtensionForStacks,
  backupModelPolicyExtensionForStacks,
  restoreConfigFiles,
  restoreSkillLoaderBackup,
  restoreReasoningSummaryExtensionBackup,
  restoreSessionTitleExtensionBackup,
  restoreSessionCommunicationExtensionBackup,
  restoreModelCatalogExtensionBackup,
  restoreModelPolicyExtensionBackup,
  rollbackScriptWithRecovery,
  runScript,
  runTransaction,
  scriptEnvironment,
  ensurePiWebRunning,
  isStandalonePiCommand,
  isPiWebProcess,
  killPiWebProcesses,
  listPiWebProcesses,
  manualUpdateGuidance,
  piWebIdle,
  piWebLaunchSpec,
  readCertifiedManifest,
  relaunchPiWeb,
  restartPiWebCommand,
  runLauncher,
  validateSkillLoaderIdentity,
  validateReasoningSummaryExtensionIdentity,
  validateSessionTitleExtensionIdentity,
  validateSessionCommunicationExtensionIdentity,
  validateModelCatalogExtensionIdentity,
  validateModelPolicyExtensionIdentity,
  validateInstalledExtensionIdentities,
  STATUS_COPY_FILE,
  UPDATE_LOG_FILE,
  UPDATE_STATE_DIR,
} = require(path.join(repoRoot, "lib", "pui-updater.js"));

const updaterModulePath = path.join(repoRoot, "lib", "pui-updater.js");

// Runs the updater in a child process whose temporary directory and home are test
// owned, so no test ever reads or writes the real ~/.pi or the live status file.
function runUpdaterChild(home, body) {
  const temporary = path.join(home, "tmp");
  fs.mkdirSync(temporary, { recursive: true });
  const source = `const os = require("node:os");\nconst updater = require(${JSON.stringify(updaterModulePath)});\n${body}`;
  const result = spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: temporary, TEMP: temporary, TMP: temporary },
  });
  assert.equal(result.status, 0, `child exited ${result.status}: ${result.stderr}`);
  return { ...JSON.parse(result.stdout), temporary };
}

function certifiedManifest(root, files = { "updater.js": "placeholder" }) {
  const core = { owner: "PUI", schemaVersion: 1, puiVersion: "1.0.0", managed: {}, files };
  return { ...core, identityHash: require("node:crypto").createHash("sha256").update(JSON.stringify(core)).digest("hex") };
}

test("certified manifest accepts a valid installed updater identity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-manifest-valid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hashes = {};
  for (const name of ["index.ts", "updater.js", "pui-release.js", "pui-config.js"]) {
    const file = path.join(root, name);
    fs.writeFileSync(file, name === "updater.js" ? "module.exports = {};" : `// ${name}`);
    hashes[name] = require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  const manifestFile = path.join(root, "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(certifiedManifest(root, hashes)));
  assert.equal(readCertifiedManifest(manifestFile).puiVersion, "1.0.0");
});

test("certified manifest rejects an incomplete installed extension shape", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-manifest-incomplete-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const updater = path.join(root, "updater.js");
  fs.writeFileSync(updater, "module.exports = {};");
  const hash = require("node:crypto").createHash("sha256").update(fs.readFileSync(updater)).digest("hex");
  const manifestFile = path.join(root, "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(certifiedManifest(root, { "updater.js": hash })));
  assert.throws(() => readCertifiedManifest(manifestFile), /file|shape|identity/i);
});

test("certified manifest rejects a missing or hash-mismatched updater before it can load", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-manifest-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const updater = path.join(root, "updater.js");
  fs.writeFileSync(updater, "module.exports = {};");
  const manifestFile = path.join(root, "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(certifiedManifest(root, { "updater.js": "0" })));
  assert.throws(() => readCertifiedManifest(manifestFile), /hash|modified/i);
  fs.writeFileSync(manifestFile, JSON.stringify(certifiedManifest(root, { "../escape.js": "0" })));
  assert.throws(() => readCertifiedManifest(manifestFile), /path|invalid|modified/i);
});

test("transaction config backups restore pre-update user state", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-config-transaction-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "settings.json");
  fs.writeFileSync(live, JSON.stringify({ user: true, managed: "old" }));
  const backups = backupConfigFiles({ configPaths: { piSettings: live } }, path.join(temp, "backups"));
  fs.writeFileSync(live, JSON.stringify({ user: true, managed: "new" }));
  restoreConfigFiles(backups);
  assert.deepEqual(JSON.parse(fs.readFileSync(live, "utf8")), { user: true, managed: "old" });
});

test("checkpoint routes back up every distinct config surface once", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-route-config-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const current = path.join(temp, "current.json");
  const shared = path.join(temp, "shared.json");
  const checkpoint = path.join(temp, "checkpoint.json");
  const target = path.join(temp, "target.json");
  for (const file of [current, shared, checkpoint, target]) fs.writeFileSync(file, JSON.stringify({ file }));

  const backups = backupConfigFilesForStacks([
    { configPaths: { piSettings: current, mcpShared: shared } },
    { configPaths: { piSettings: checkpoint, mcpShared: shared } },
    { configPaths: { piSettings: target, mcpShared: shared } },
  ], path.join(temp, "backups"));

  assert.deepEqual(new Set(backups.map((entry) => entry.file)), new Set([current, shared, checkpoint, target]));
  assert.equal(backups.filter((entry) => entry.file === shared).length, 1);
});

test("transaction backups include every managed JSON config surface", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-all-config-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const configPaths = Object.fromEntries(
    ["piSettings", "piWebAccess", "mcpShared", "piFffFeatures", "piGoal", "askUserQuestion", "puiSubagents", "puiReasoningSummaries", "puiSessionTitles", "puiModelPolicy"]
      .map((key) => [key, path.join(temp, `${key}.json`)]),
  );
  for (const file of Object.values(configPaths)) fs.writeFileSync(file, JSON.stringify({ file }));

  const backups = backupConfigFiles({
    configPaths,
    askUserQuestion: { configRelativePath: "rpiv-ask-user-question/config.json" },
  }, path.join(temp, "backups"));

  assert.deepEqual(new Set(backups.map((entry) => entry.file)), new Set(Object.values(configPaths)));
});

test("pre-1.3.0 validation accepts compositions without introduced extensions", () => {
  assert.doesNotThrow(() => validateInstalledExtensionIdentities("1.2.2", {
    skillLoader: path.join(os.tmpdir(), "missing-skill-loader"),
    reasoningSummary: path.join(os.tmpdir(), "missing-reasoning-summary"),
    sessionTitle: path.join(os.tmpdir(), "missing-session-title"),
  }));
  assert.throws(() => validateInstalledExtensionIdentities("1.3.0", {
    skillLoader: path.join(os.tmpdir(), "missing-skill-loader"),
    reasoningSummary: path.join(os.tmpdir(), "missing-reasoning-summary"),
    sessionTitle: path.join(os.tmpdir(), "missing-session-title"),
  }), /skill loader/i);
});

test("transaction validation rejects skill-loader identity drift", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-skill-loader-validation-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, "pui-skill-loader");
  require(path.join(repoRoot, "lib", "pui-skill-loader-extension.js")).installExtension({ repoRoot, target });
  assert.doesNotThrow(() => validateSkillLoaderIdentity(require(path.join(repoRoot, "package.json")).version, target));
  const manifestFile = path.join(target, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.unexpected = true;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => validateSkillLoaderIdentity(require(path.join(repoRoot, "package.json")).version, target), /identity/);
  delete manifest.unexpected;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.appendFileSync(path.join(target, "core.ts"), "\nmodified");
  assert.throws(() => validateSkillLoaderIdentity(require(path.join(repoRoot, "package.json")).version, target), /mismatch/);
  fs.rmSync(target, { recursive: true });
  require(path.join(repoRoot, "lib", "pui-skill-loader-extension.js")).installExtension({ repoRoot, target });
  fs.writeFileSync(path.join(target, "extra.ts"), "unowned");
  assert.throws(() => validateSkillLoaderIdentity(require(path.join(repoRoot, "package.json")).version, target), /identity/);
});

test("transaction validation rejects reasoning-summary extension identity drift", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-reasoning-summary-validation-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, "pui-reasoning-summary");
  require(path.join(repoRoot, "lib", "pui-reasoning-summary-extension.js")).installExtension({ repoRoot, target });
  assert.doesNotThrow(() => validateReasoningSummaryExtensionIdentity(require(path.join(repoRoot, "package.json")).version, target));
  fs.appendFileSync(path.join(target, "core.ts"), "\nmodified");
  assert.throws(() => validateReasoningSummaryExtensionIdentity(require(path.join(repoRoot, "package.json")).version, target), /mismatch/);
  fs.rmSync(target, { recursive: true });
  require(path.join(repoRoot, "lib", "pui-reasoning-summary-extension.js")).installExtension({ repoRoot, target });
  fs.writeFileSync(path.join(target, "extra.ts"), "unowned");
  assert.throws(() => validateReasoningSummaryExtensionIdentity(require(path.join(repoRoot, "package.json")).version, target), /identity/);
});

test("transaction validation rejects session-title extension identity drift", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-title-validation-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, "pui-session-title");
  require(path.join(repoRoot, "lib", "pui-session-title-extension.js")).installExtension({ repoRoot, target });
  assert.doesNotThrow(() => validateSessionTitleExtensionIdentity(require(path.join(repoRoot, "package.json")).version, target));
  fs.appendFileSync(path.join(target, "core.ts"), "\nmodified");
  assert.throws(() => validateSessionTitleExtensionIdentity(require(path.join(repoRoot, "package.json")).version, target), /mismatch/);
});

test("transaction validation requires session communication identity from v1.3.2", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-communication-validation-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, "pui-session-communication");
  require(path.join(repoRoot, "lib", "pui-session-communication-extension.js")).installExtension({ repoRoot, target });
  assert.doesNotThrow(() => validateSessionCommunicationExtensionIdentity(installedVersion, target));
  fs.appendFileSync(path.join(target, "core.ts"), "\nmodified");
  assert.throws(() => validateSessionCommunicationExtensionIdentity(installedVersion, target), /mismatch/);
});

test("transaction validation requires model catalog identity from v1.3.2", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-model-catalog-validation-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, "pui-model-catalog");
  require(path.join(repoRoot, "lib", "pui-model-catalog-extension.js")).installExtension({ repoRoot, target });
  assert.doesNotThrow(() => validateModelCatalogExtensionIdentity(installedVersion, target));
  fs.appendFileSync(path.join(target, "core.ts"), "\nmodified");
  assert.throws(() => validateModelCatalogExtensionIdentity(installedVersion, target), /mismatch/);
});

test("transaction validation and rollback cover the model policy extension", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-model-policy-transaction-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-model-policy");
  const backup = backupModelPolicyExtensionForStacks([
    { modelPolicyExtension: { target: live } },
  ], path.join(temp, "backup"));
  require(path.join(repoRoot, "lib", "pui-model-policy-extension.js")).installExtension({ repoRoot, target: live });
  assert.doesNotThrow(() => validateModelPolicyExtensionIdentity(installedVersion, live));
  fs.appendFileSync(path.join(live, "core.ts"), "\nmodified");
  assert.throws(() => validateModelPolicyExtensionIdentity(installedVersion, live), /mismatch/);
  assert.throws(() => restoreModelPolicyExtensionBackup(backup), /drift/i);
  fs.rmSync(live, { recursive: true });
  require(path.join(repoRoot, "lib", "pui-model-policy-extension.js")).installExtension({ repoRoot, target: live });
  restoreModelPolicyExtensionBackup(backup);
  assert.equal(fs.existsSync(live), false);
});

test("transaction rollback removes a newly introduced model catalog extension", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-model-catalog-transaction-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-model-catalog");
  const backup = backupModelCatalogExtensionForStacks([
    { modelCatalogExtension: { target: live } },
  ], path.join(temp, "backup"));
  require(path.join(repoRoot, "lib", "pui-model-catalog-extension.js")).installExtension({ repoRoot, target: live });
  restoreModelCatalogExtensionBackup(backup);
  assert.equal(fs.existsSync(live), false);
});

test("transaction rollback preserves post-backup model catalog drift", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-model-catalog-drift-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-model-catalog");
  require(path.join(repoRoot, "lib", "pui-model-catalog-extension.js")).installExtension({ repoRoot, target: live });
  const backup = backupModelCatalogExtensionForStacks([
    { modelCatalogExtension: { target: live } },
  ], path.join(temp, "backup"));
  fs.appendFileSync(path.join(live, "core.ts"), "\nuser change");
  assert.throws(() => restoreModelCatalogExtensionBackup(backup), /drift/i);
  assert.match(fs.readFileSync(path.join(live, "core.ts"), "utf8"), /user change/);
});

test("transaction rollback removes a newly introduced session communication extension", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-communication-transaction-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-session-communication");
  const backup = backupSessionCommunicationExtensionForStacks([
    { sessionCommunicationExtension: { target: live } },
  ], path.join(temp, "backup"));
  require(path.join(repoRoot, "lib", "pui-session-communication-extension.js")).installExtension({ repoRoot, target: live });
  restoreSessionCommunicationExtensionBackup(backup);
  assert.equal(fs.existsSync(live), false);
});

test("transaction rollback restores the exact pre-update session-title extension", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-title-transaction-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-session-title");
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, "index.ts"), "old extension");
  const backup = backupSessionTitleExtensionForStacks([
    { sessionTitleExtension: { target: live } },
  ], path.join(temp, "backup"));
  fs.rmSync(live, { recursive: true });
  require(path.join(repoRoot, "lib", "pui-session-title-extension.js")).installExtension({ repoRoot, target: live });
  restoreSessionTitleExtensionBackup(backup);
  assert.equal(fs.readFileSync(path.join(live, "index.ts"), "utf8"), "old extension");
});

test("transaction rollback preserves post-backup session-title drift", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-title-drift-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-session-title");
  require(path.join(repoRoot, "lib", "pui-session-title-extension.js")).installExtension({ repoRoot, target: live });
  const backup = backupSessionTitleExtensionForStacks([
    { sessionTitleExtension: { target: live } },
  ], path.join(temp, "backup"));
  fs.appendFileSync(path.join(live, "core.ts"), "\nuser change");

  assert.throws(() => restoreSessionTitleExtensionBackup(backup), /drift/i);
  assert.match(fs.readFileSync(path.join(live, "core.ts"), "utf8"), /user change/);
});

test("transaction rollback removes a newly introduced session-title extension", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-title-introduced-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-session-title");
  const backup = backupSessionTitleExtensionForStacks([
    { sessionTitleExtension: { target: live } },
  ], path.join(temp, "backup"));
  require(path.join(repoRoot, "lib", "pui-session-title-extension.js")).installExtension({ repoRoot, target: live });
  restoreSessionTitleExtensionBackup(backup);
  assert.equal(fs.existsSync(live), false);
});

test("transaction rollback restores the exact pre-update reasoning-summary extension", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-reasoning-summary-transaction-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-reasoning-summary");
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, "index.ts"), "old extension");
  const backup = backupReasoningSummaryExtensionForStacks([
    { reasoningSummaryExtension: { target: live } },
  ], path.join(temp, "backup"));
  fs.rmSync(live, { recursive: true });
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, "index.ts"), "new extension");
  restoreReasoningSummaryExtensionBackup(backup);
  assert.equal(fs.readFileSync(path.join(live, "index.ts"), "utf8"), "old extension");
});

test("transaction rollback removes a newly introduced reasoning-summary extension", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-reasoning-summary-introduced-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-reasoning-summary");
  const backup = backupReasoningSummaryExtensionForStacks([
    { reasoningSummaryExtension: { target: live } },
  ], path.join(temp, "backup"));
  fs.mkdirSync(live, { recursive: true });
  restoreReasoningSummaryExtensionBackup(backup);
  assert.equal(fs.existsSync(live), false);
});

test("transaction rollback restores the exact pre-update skill-loader directory", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-skill-loader-transaction-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-skill-loader");
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, "index.ts"), "old extension");
  fs.writeFileSync(path.join(live, "manifest.json"), "old manifest");

  const backup = backupSkillLoaderForStacks([
    { skillLoaderExtension: { target: live } },
  ], path.join(temp, "backup"));
  fs.rmSync(live, { recursive: true });
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, "index.ts"), "new extension");

  restoreSkillLoaderBackup(backup);
  assert.equal(fs.readFileSync(path.join(live, "index.ts"), "utf8"), "old extension");
  assert.equal(fs.readFileSync(path.join(live, "manifest.json"), "utf8"), "old manifest");
});

test("transaction rollback removes a newly introduced skill-loader directory", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-skill-loader-introduced-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const live = path.join(temp, "pui-skill-loader");
  const backup = backupSkillLoaderForStacks([
    { skillLoaderExtension: { target: live } },
  ], path.join(temp, "backup"));
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, "index.ts"), "new extension");
  restoreSkillLoaderBackup(backup);
  assert.equal(fs.existsSync(live), false);
});

test("transaction rollback restores the background-task bundle and ownership sidecars", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-background-transaction-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const npmRoot = path.join(temp, "npm");
  const packageDir = path.join(npmRoot, "node_modules", "@99percentpeople", "pi-background-tasks");
  const bundle = path.join(packageDir, "index.min.js");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(bundle, "original bundle");
  const patch = {
    packagePath: "node_modules/@99percentpeople/pi-background-tasks",
    bundle: "index.min.js",
    backupSuffix: ".pui-original",
    manifestSuffix: ".pui-manifest.json",
  };

  const backups = backupBackgroundTaskFilesForStacks(
    [{}, { backgroundTasksPromptPatch: patch }],
    path.join(temp, "backups"),
    npmRoot,
  );
  assert.deepEqual(backups.map((entry) => [path.basename(entry.file), entry.existed]), [
    ["index.min.js", true],
    ["index.min.js.pui-original", false],
    ["index.min.js.pui-manifest.json", false],
  ]);

  fs.writeFileSync(bundle, "patched bundle");
  fs.writeFileSync(`${bundle}.pui-original`, "original bundle");
  fs.writeFileSync(`${bundle}.pui-manifest.json`, "owned");
  restoreConfigFiles(backups);
  assert.equal(fs.readFileSync(bundle, "utf8"), "original bundle");
  assert.equal(fs.existsSync(`${bundle}.pui-original`), false);
  assert.equal(fs.existsSync(`${bundle}.pui-manifest.json`), false);
});

test("transaction rollback restores subagent prompt files and ownership sidecars", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-subagents-transaction-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const npmRoot = path.join(temp, "npm");
  const packageDir = path.join(npmRoot, "node_modules", "@gotgenes", "pi-subagents");
  const relativeFiles = ["src/tools/agent-tool.ts", "src/config/default-agents.ts", "src/config/invocation-config.ts"];
  for (const relative of relativeFiles) {
    const file = path.join(packageDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `original ${relative}`);
  }
  const patch = {
    packagePath: "node_modules/@gotgenes/pi-subagents",
    files: relativeFiles,
    backupSuffix: ".pui-original",
    manifest: ".pui-subagents-prompt-manifest.json",
  };

  const backups = backupSubagentFilesForStacks(
    [{}, { subagentsPromptPatch: patch }],
    path.join(temp, "backups"),
    npmRoot,
  );
  assert.equal(backups.length, 7);
  assert.equal(backups.filter((entry) => entry.existed).length, 3);

  for (const relative of relativeFiles) {
    const file = path.join(packageDir, relative);
    fs.writeFileSync(file, `patched ${relative}`);
    fs.writeFileSync(`${file}.pui-original`, `original ${relative}`);
  }
  fs.writeFileSync(path.join(packageDir, patch.manifest), "owned");
  restoreConfigFiles(backups);
  for (const relative of relativeFiles) {
    const file = path.join(packageDir, relative);
    assert.equal(fs.readFileSync(file, "utf8"), `original ${relative}`);
    assert.equal(fs.existsSync(`${file}.pui-original`), false);
  }
  assert.equal(fs.existsSync(path.join(packageDir, patch.manifest)), false);
});

test("transaction backup follows XDG_CONFIG_HOME for ask-user guidance", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-xdg-config-"));
  const previous = process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  process.env.XDG_CONFIG_HOME = path.join(temp, "xdg");
  const actual = path.join(process.env.XDG_CONFIG_HOME, "rpiv-ask-user-question", "config.json");
  fs.mkdirSync(path.dirname(actual), { recursive: true });
  fs.writeFileSync(actual, JSON.stringify({ guidance: { existing: true } }));

  const backups = backupConfigFiles({
    configPaths: { askUserQuestion: path.join(temp, "fallback.json") },
    askUserQuestion: { configRelativePath: "rpiv-ask-user-question/config.json" },
  }, path.join(temp, "backups"));

  assert.equal(backups.length, 1);
  assert.equal(backups[0].file, path.resolve(actual));
  assert.equal(backups[0].existed, true);
});

test("rollback script environment clears target failure injection", () => {
  const previous = process.env.PUI_FAIL_AT;
  process.env.PUI_FAIL_AT = "target-validation";
  try {
    assert.equal(scriptEnvironment(false).PUI_FAIL_AT, "target-validation");
    assert.equal(Object.hasOwn(scriptEnvironment(true), "PUI_FAIL_AT"), false);
  } finally {
    if (previous === undefined) delete process.env.PUI_FAIL_AT;
    else process.env.PUI_FAIL_AT = previous;
  }
});

test("detached updater starts outside the replaceable Pi Web package tree", () => {
  const options = detachedSpawnOptions();
  assert.equal(options.cwd, os.tmpdir());
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.PUI_REQUIRE_INSTALLED_IDENTITY, "1");
});

test("update lock identifies the active transaction", (t) => {
  const { LOCK_FILE, acquireLock } = require(path.join(repoRoot, "lib", "pui-updater.js"));
  const release = acquireLock();
  t.after(release);
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  assert.equal(lock.pid, process.pid);
  assert.match(lock.id, /^\d+-\d+$/);
});

test("discovery offers only a newer stable release and honors one exact skip", () => {
  assert.equal(chooseStableUpdate("1.0.0", { tag_name: "v1.1.0", draft: false, prerelease: false }, null), "1.1.0");
  assert.equal(chooseStableUpdate("1.1.0", { tag_name: "v1.1.0", draft: false, prerelease: false }, null), null);
  assert.equal(chooseStableUpdate("1.1.0", { tag_name: "v1.0.0", draft: false, prerelease: false }, null), null);
  assert.equal(chooseStableUpdate("1.0.0", { tag_name: "v1.1.0", draft: false, prerelease: false }, "1.1.0"), null);
  assert.equal(chooseStableUpdate("1.0.0", { tag_name: "v1.2.0", draft: false, prerelease: false }, "1.1.0"), "1.2.0");
  assert.equal(chooseStableUpdate("1.0.0", { tag_name: "v2.0.0-beta.1", draft: false, prerelease: true }, null), null);
  assert.equal(chooseStableUpdate("1.0.0", { tag_name: "v9.0.0", draft: true, prerelease: false }, null), null);
});

test("manual update guidance names both versions and the staged-apply escape hatch", () => {
  const message = manualUpdateGuidance("1.1.0", "1.0.5");
  assert.match(message, /v1\.1\.0 is not a published GitHub release/);
  assert.match(message, /installed identity is v1\.0\.5/);
  assert.match(message, /-ApplyStaged/);
  assert.match(message, /--apply-staged/);
});

test("busy Pi Web and standalone Pi prevent mutation", async () => {
  let checks = 0;
  let mutated = false;
  await runTransaction({
    current: "1.0.0",
    target: "1.1.0",
    waitForIdle: async () => { checks += 1; },
    standaloneBusy: async () => checks === 1,
    apply: async () => { mutated = true; },
    validate: async () => {},
    rollback: async () => {},
    writeStatus: async () => {},
    busyDelayMs: 0,
  });
  assert.equal(checks, 2);
  assert.equal(mutated, true);
});

test("Pi Web idle verification permits recovery when the endpoint and managed process are both absent", async () => {
  await piWebIdle({
    fetch: async () => { throw new Error("connection refused"); },
    listPiWebProcesses: () => [],
  });
});

test("Pi Web idle verification fails closed when a managed process exists but activity cannot be read", async () => {
  await assert.rejects(piWebIdle({
    fetch: async () => { throw new Error("connection refused"); },
    listPiWebProcesses: () => [{ pid: 42, line: "pi-web" }],
  }), /Could not verify Pi Web idle state/);
});

test("standalone Pi detection recognizes npm shim process command lines", () => {
  assert.equal(isStandalonePiCommand("node /home/me/.npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), true);
  assert.equal(isStandalonePiCommand('node.exe C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js'), true);
  assert.equal(isStandalonePiCommand("node /usr/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), false);
  assert.equal(isStandalonePiCommand("node /tmp/pui-updater.js apply 1.0.3"), false);
});
test("pi-web process detection matches the managed GUI server and excludes the agent and the restarter", () => {
  assert.equal(isPiWebProcess("node /usr/lib/node_modules/@agegr/pi-web/node_modules/next/dist/bin/next start -p 30141"), true);
  assert.equal(isPiWebProcess("node /c/Users/me/AppData/Roaming/npm/node_modules/@agegr/pi-web/bin/pi-web.js --no-open"), true);
  assert.equal(isPiWebProcess("node /home/me/.npm/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), false);
  assert.equal(isPiWebProcess("node /home/me/.pi/agent/extensions/pui-update/updater.js restart"), false);
});

test("pi-web process detection matches the npm bin shim without matching lookalike commands", () => {
  assert.equal(isPiWebProcess("node /Users/me/.nvm/versions/node/v24.13.0/bin/pi-web --no-open"), true);
  assert.equal(isPiWebProcess("node /usr/local/bin/pi-web.js --no-open"), true);
  assert.equal(isPiWebProcess('node "C:\\Users\\me\\AppData\\Roaming\\npm\\bin\\pi-web.js" --no-open'), true);
  assert.equal(isPiWebProcess("grep pi-web"), false);
  assert.equal(isPiWebProcess("vi pi-web"), false);
  assert.equal(isPiWebProcess("node /Users/me/.pi/agent/extensions/pui-update/updater.js apply 1.3.2"), false);
  assert.equal(isPiWebProcess("node /Users/me/tools/bin/pi-web-helper.js"), false);
});

test("process listing includes the retitled Next.js child but not the detached updater", () => {
  const calls = [];
  const psOutput = [
    "  501     1 node /Users/me/.nvm/versions/node/v24.13.0/bin/pi-web --no-open",
    "  502   501 next-server (v16.3.1)      ",
    "  503   501 node /Users/me/.pi/agent/extensions/pui-update/updater.js apply 1.3.2",
    "  504   501 node /Users/me/tools/node_modules/other/next-server-helper.js",
    "  505     1 next-server (v16.3.1)",
    "  506     1 node /usr/lib/node_modules/@agegr/pi-web/node_modules/next/dist/bin/next start -p 30141",
  ].join("\n");
  const processes = listPiWebProcesses({
    platform: "linux",
    spawnSync: (...args) => { calls.push(args); return { status: 0, stdout: psOutput, stderr: "" }; },
  });
  assert.deepEqual(calls[0][0], "ps");
  assert.deepEqual(calls[0][1], ["-eo", "pid=,ppid=,args="]);
  assert.equal(calls[0][2].windowsHide, true);
  assert.deepEqual(processes.map((process) => process.pid), [501, 506, 502]);
  assert.equal(processes[2].line, "next-server (v16.3.1)      ");
});

test("Windows process listing keeps the pid and command-line pipe format", () => {
  const calls = [];
  const processes = listPiWebProcesses({
    platform: "win32",
    spawnSync: (...args) => {
      calls.push(args);
      return { status: 0, stdout: "1234|node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@agegr\\pi-web\\bin\\pi-web.js --no-open\r\n5678|node C:\\other\\app.js\r\n", stderr: "" };
    },
  });
  assert.equal(calls[0][0], "powershell.exe");
  assert.deepEqual(processes, [{ pid: 1234, line: "node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@agegr\\pi-web\\bin\\pi-web.js --no-open" }]);
});

test("stopping Pi Web kills the shim and its retitled child but never the updater itself", () => {
  const killed = [];
  killPiWebProcesses({
    listPiWebProcesses: () => [
      { pid: 501, line: "node /Users/me/.nvm/versions/node/v24.13.0/bin/pi-web --no-open" },
      { pid: 502, line: "next-server (v16.3.1)" },
      { pid: process.pid, line: "node /Users/me/bin/pi-web --no-open" },
    ],
    kill: (pid, signal) => killed.push([pid, signal]),
  });
  assert.deepEqual(killed, [[501, "SIGKILL"], [502, "SIGKILL"]]);

  const isolated = [];
  killPiWebProcesses({
    listPiWebProcesses: () => [{ pid: 501, line: "node /Users/me/bin/pi-web --no-open" }],
    kill: (pid) => { isolated.push(pid); throw new Error("EPERM"); },
  });
  assert.deepEqual(isolated, [501]);
});

test("Windows relaunch uses the canonical VBS so Pi Web descendants inherit a hidden console", () => {
  const piWebCmd = path.join("appdata", "npm", "pi-web.cmd");
  const launcherVbs = path.join("appdata", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "pui-piweb.vbs");
  const expectedVbs = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run "cmd /c set PI_WEB_SKIP_VERSION_CHECK=1&&""${piWebCmd}"" --no-open", 0, False`;
  const spec = piWebLaunchSpec({
    platform: "win32",
    appData: "appdata",
    wscriptExecutable: "wscript.exe",
    existsSync: (p) => p === piWebCmd || p === launcherVbs,
    readFileSync: (p) => p === launcherVbs ? expectedVbs : "",
  });
  assert.equal(spec.file, "wscript.exe");
  assert.deepEqual(spec.args, [launcherVbs]);
  assert.equal(spec.stopsExisting, false);
});

test("Windows relaunch executes a spaced absolute command through the hidden VBS", { skip: process.platform !== "win32" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui launcher probe "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const piWebCmd = path.join(root, "pi-web.cmd");
  const launcherVbs = path.join(root, "pui-piweb.vbs");
  const marker = path.join(root, "result.txt");
  fs.writeFileSync(piWebCmd, `@echo off\r\n> "${marker}" echo ARGS=%* ENV=%PI_WEB_SKIP_VERSION_CHECK%\r\n`);
  fs.writeFileSync(launcherVbs, `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run "cmd /c set PI_WEB_SKIP_VERSION_CHECK=1&&""${piWebCmd}"" --no-open", 0, False`);
  const spec = piWebLaunchSpec({ platform: "win32", piWebCmd, launcherVbs, existsSync: (p) => p === piWebCmd || p === launcherVbs });
  const result = spawnSync(spec.file, spec.args, { windowsHide: true });
  assert.equal(result.status, 0);
  for (let attempt = 0; attempt < 30 && !fs.existsSync(marker); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "ARGS=--no-open ENV=1");
});

test("Windows relaunch rejects a missing or modified hidden launcher", () => {
  const piWebCmd = path.join("appdata", "npm", "pi-web.cmd");
  const launcherVbs = path.join("appdata", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "pui-piweb.vbs");
  assert.throws(() => piWebLaunchSpec({ platform: "win32", appData: "appdata", existsSync: () => false }), /launcher is missing.*pi-web\.cmd/i);
  assert.throws(() => piWebLaunchSpec({
    platform: "win32",
    appData: "appdata",
    existsSync: (p) => p === piWebCmd || p === launcherVbs,
    readFileSync: () => "modified",
  }), /hidden launcher is modified/i);
});

test("staged script failures retain output in the transaction log and surface the useful error", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-script-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logFile = path.join(root, "update.log");
  fs.writeFileSync(path.join(root, "update.sh"), "#!/usr/bin/env bash\necho 'launcher health failed' >&2\nexit 7\n");
  fs.chmodSync(path.join(root, "update.sh"), 0o755);
  fs.writeFileSync(path.join(root, "update.ps1"), "Write-Error 'launcher health failed'\nexit 7\n");
  assert.throws(() => runScript(root, [], { logFile, label: "target v1.2.2" }), /launcher health failed/);
  assert.match(fs.readFileSync(logFile, "utf8"), /target v1\.2\.2[\s\S]*launcher health failed/);
});

test("restart relaunch delegates stop+start to the service manager when autostart is managed", () => {
  const plist = path.join("/home/u", "Library", "LaunchAgents", "com.pui.piweb.plist");
  const mac = piWebLaunchSpec({ platform: "darwin", home: "/home/u", uid: 501, existsSync: (p) => p === plist });
  assert.equal(mac.file, "launchctl");
  assert.deepEqual(mac.args, ["kickstart", "-k", "gui/501/com.pui.piweb"]);
  assert.equal(mac.stopsExisting, true);

  const unit = path.join("/home/u", ".config", "systemd", "user", "pui-piweb.service");
  const linux = piWebLaunchSpec({ platform: "linux", home: "/home/u", existsSync: (p) => p === unit });
  assert.equal(linux.file, "systemctl");
  assert.deepEqual(linux.args, ["--user", "restart", "pui-piweb"]);
  assert.equal(linux.stopsExisting, true);
});

test("restart relaunch falls back to a detached pi-web spawn on unmanaged POSIX installs", () => {
  const spec = piWebLaunchSpec({ platform: "linux", home: "/home/u", existsSync: () => false });
  assert.equal(spec.file, "pi-web");
  assert.deepEqual(spec.args, ["--no-open"]);
  assert.equal(spec.stopsExisting, false);
});

test("restart relaunch records the supervisor recovery command for a booted-out job", () => {
  const plist = path.join("/home/u", "Library", "LaunchAgents", "com.pui.piweb.plist");
  const mac = piWebLaunchSpec({ platform: "darwin", home: "/home/u", uid: 501, existsSync: (p) => p === plist });
  assert.deepEqual(mac.recovery, { file: "launchctl", args: ["load", plist] });

  const unit = path.join("/home/u", ".config", "systemd", "user", "pui-piweb.service");
  const linux = piWebLaunchSpec({ platform: "linux", home: "/home/u", existsSync: (p) => p === unit });
  assert.deepEqual(linux.recovery, { file: "systemctl", args: ["--user", "start", "pui-piweb"] });
});

test("unmanaged and Windows relaunches keep no supervisor recovery", () => {
  const unmanaged = piWebLaunchSpec({ platform: "linux", home: "/home/u", existsSync: () => false });
  assert.equal(unmanaged.recovery, null);
  // `pi-web --no-open` serves in the foreground, so this launcher stays fire-and-forget.
  assert.equal(unmanaged.detached, true);
  assert.equal(piWebLaunchSpec({ platform: "darwin", home: "/home/u", uid: 501, existsSync: () => false }).recovery, null);

  const piWebCmd = path.join("appdata", "npm", "pi-web.cmd");
  const launcherVbs = path.join("appdata", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "pui-piweb.vbs");
  const expectedVbs = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run "cmd /c set PI_WEB_SKIP_VERSION_CHECK=1&&""${piWebCmd}"" --no-open", 0, False`;
  const windows = piWebLaunchSpec({
    platform: "win32",
    appData: "appdata",
    existsSync: (p) => p === piWebCmd || p === launcherVbs,
    readFileSync: () => expectedVbs,
  });
  assert.equal(windows.recovery, null);
  assert.equal(windows.detached, undefined);
});

test("launcher diagnostics report a non-zero exit and its stderr instead of swallowing them", async () => {
  const args = ["-e", 'process.stderr.write("Could not find service\\n"); process.exit(113)'];
  const result = await runLauncher({ file: process.execPath, args });
  assert.equal(result.command, [process.execPath, ...args].join(" "));
  assert.equal(result.code, 113);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "Could not find service");
  assert.equal(result.error, undefined);
});

test("launcher diagnostics resolve a missing launcher and cap captured stderr", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-launcher-probe-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const missing = await runLauncher({ file: path.join(temp, "missing-launchctl"), args: [] });
  assert.equal(missing.code, null);
  assert.equal(missing.error.code, "ENOENT");

  const noisy = await runLauncher({ file: process.execPath, args: ["-e", 'process.stderr.write("e".repeat(8000))'] });
  assert.equal(noisy.code, 0);
  assert.ok(noisy.stderr.length > 0 && noisy.stderr.length <= 2000, `captured stderr length ${noisy.stderr.length}`);
});

test("relaunch recovers a booted-out LaunchAgent instead of leaving Pi Web down", async () => {
  const launch = await relaunchPiWeb({
    file: process.execPath,
    args: ["-e", 'process.stderr.write("Could not find service \\"com.pui.piweb\\" in domain for user gui: 501\\n"); process.exit(113)'],
    stopsExisting: true,
    recovery: { file: process.execPath, args: ["-e", "process.exit(0)"] },
  });
  assert.equal(launch.ok, true);
  assert.equal(launch.attempts.length, 2);
  assert.equal(launch.attempts[0].code, 113);
  assert.match(launch.attempts[0].stderr, /Could not find service/);
  assert.equal(launch.attempts[1].code, 0);
});

test("relaunch reports both failed attempts when the supervisor recovery also fails", async () => {
  const launch = await relaunchPiWeb({
    file: process.execPath,
    args: ["-e", "process.exit(113)"],
    stopsExisting: true,
    recovery: { file: process.execPath, args: ["-e", 'process.stderr.write("Load failed\\n"); process.exit(1)'] },
  });
  assert.equal(launch.ok, false);
  assert.deepEqual(launch.attempts.map((attempt) => attempt.code), [113, 1]);
});

test("relaunch skips recovery after a successful launch and when no recovery exists", async () => {
  const launched = await relaunchPiWeb({ file: process.execPath, args: ["-e", "process.exit(0)"], stopsExisting: true, recovery: { file: "must-not-run", args: [] } });
  assert.equal(launched.ok, true);
  assert.equal(launched.attempts.length, 1);

  const unsupported = await relaunchPiWeb({ file: process.execPath, args: ["-e", "process.exit(1)"], stopsExisting: false, recovery: null });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.attempts.length, 1);
});

test("detached relaunch reports the spawn result without waiting for the server to exit", async (t) => {
  const started = Date.now();
  const launch = await relaunchPiWeb({ file: process.execPath, args: ["-e", "setTimeout(() => {}, 2000)"], stopsExisting: false, recovery: null, detached: true });
  const elapsed = Date.now() - started;
  assert.equal(launch.ok, true);
  assert.equal(launch.attempts[0].detached, true);
  assert.equal(launch.attempts[0].code, null);
  assert.ok(elapsed < 1500, `detached relaunch waited ${elapsed}ms for the foreground server to exit`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-detached-missing-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const missing = await relaunchPiWeb({ file: path.join(temp, "missing-pi-web"), args: ["--no-open"], stopsExisting: false, recovery: null, detached: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.attempts[0].error.code, "ENOENT");
});

test("relaunch recovers when the supervisor launcher cannot be spawned at all", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-launcher-missing-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const launch = await relaunchPiWeb({
    file: path.join(temp, "missing-systemctl"),
    args: ["--user", "restart", "pui-piweb"],
    stopsExisting: true,
    recovery: { file: process.execPath, args: ["-e", "process.exit(0)"] },
  });
  assert.equal(launch.ok, true);
  assert.equal(launch.attempts[0].error.code, "ENOENT");
  assert.equal(launch.attempts[1].code, 0);
});

test("Pi Web relaunch hands its launch diagnostics to the caller after the health gate", async () => {
  const events = [];
  const result = await ensurePiWebRunning({
    piWebHealthy: async () => { events.push("health"); return false; },
    relaunchPiWeb: async () => {
      events.push("relaunch");
      return { ok: false, attempts: [{ command: "launchctl kickstart -k gui/501/com.pui.piweb", code: 113, signal: null, stderr: "Could not find service" }] };
    },
  });
  assert.deepEqual(events, ["health", "relaunch"]);
  assert.equal(result.ok, false);
  assert.equal(result.attempts[0].code, 113);

  const healthy = await ensurePiWebRunning({
    piWebHealthy: async () => true,
    relaunchPiWeb: async () => { throw new Error("a healthy Pi Web must not be relaunched"); },
  });
  assert.deepEqual(healthy, { ok: true, attempts: [] });
});

test("restart failure records the launcher diagnostics in the status file", async (t) => {
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  const statuses = [];
  await restartPiWebCommand({
    writeStatus: (status) => statuses.push(status),
    piWebLaunchSpec: () => ({ file: "launchctl", args: ["kickstart", "-k", "gui/501/com.pui.piweb"], stopsExisting: true, recovery: { file: "launchctl", args: ["load", "/home/u/Library/LaunchAgents/com.pui.piweb.plist"] } }),
    relaunchPiWeb: async () => ({
      ok: false,
      attempts: [{ command: "launchctl kickstart -k gui/501/com.pui.piweb", code: 113, signal: null, stderr: 'Could not find service "com.pui.piweb" in domain for user gui: 501' }],
    }),
    piWebHealthy: async () => false,
    sleepMs: () => {},
    initialDelayMs: 0,
    healthAttempts: 1,
    healthDelayMs: 0,
  });
  assert.deepEqual(statuses.map((status) => status.phase), ["restarting", "failed"]);
  assert.equal(statuses[1].result, "failed");
  assert.equal(statuses[1].error, 'Pi Web did not become healthy after restart (launchctl kickstart -k gui/501/com.pui.piweb exited 113: Could not find service "com.pui.piweb" in domain for user gui: 501)');
  assert.equal(process.exitCode, 1);
});

test("restart failure reports every failed attempt including a spawn error", async (t) => {
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  const statuses = [];
  await restartPiWebCommand({
    writeStatus: (status) => statuses.push(status),
    piWebLaunchSpec: () => ({ file: "systemctl", args: ["--user", "restart", "pui-piweb"], stopsExisting: true, recovery: { file: "systemctl", args: ["--user", "start", "pui-piweb"] } }),
    relaunchPiWeb: async () => ({
      ok: false,
      attempts: [
        { command: "systemctl --user restart pui-piweb", code: null, signal: null, stderr: "", error: new Error("spawn systemctl ENOENT") },
        { command: "systemctl --user start pui-piweb", code: 5, signal: null, stderr: "Failed to start pui-piweb.service" },
      ],
    }),
    piWebHealthy: async () => false,
    sleepMs: () => {},
    initialDelayMs: 0,
    healthAttempts: 1,
    healthDelayMs: 0,
  });
  assert.match(statuses[1].error, /^Pi Web did not become healthy after restart \(systemctl --user restart pui-piweb failed: spawn systemctl ENOENT; systemctl --user start pui-piweb exited 5: Failed to start pui-piweb\.service\)$/);
});

test("restart success reports restarted without a failure status", async () => {
  const statuses = [];
  await restartPiWebCommand({
    writeStatus: (status) => statuses.push(status),
    piWebLaunchSpec: () => ({ file: "launchctl", args: ["kickstart", "-k", "gui/501/com.pui.piweb"], stopsExisting: true, recovery: { file: "launchctl", args: ["load", "/home/u/Library/LaunchAgents/com.pui.piweb.plist"] } }),
    relaunchPiWeb: async () => ({ ok: true, attempts: [{ command: "launchctl kickstart -k gui/501/com.pui.piweb", code: 0, signal: null, stderr: "" }] }),
    piWebHealthy: async () => true,
    sleepMs: () => {},
    initialDelayMs: 0,
  });
  assert.deepEqual(statuses.map((status) => status.phase), ["restarting", "complete"]);
  assert.equal(statuses[1].result, "restarted");
});

test("update evidence lives outside the temporary directory that a reboot wipes", () => {
  assert.equal(UPDATE_STATE_DIR, path.join(os.homedir(), ".pi", "agent", "state", "pui-update"));
  assert.equal(UPDATE_LOG_FILE, path.join(UPDATE_STATE_DIR, "last.log"));
  assert.equal(STATUS_COPY_FILE, path.join(UPDATE_STATE_DIR, "last-status.json"));
});

test("status writes mirror the authoritative temporary status into the persistent state directory", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pui-update-state-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const child = runUpdaterChild(home, `
    updater.writeStatus({ phase: "failed", result: "failed", error: "step X" });
    process.stdout.write(JSON.stringify({
      homedir: os.homedir(),
      statusFile: updater.STATUS_FILE,
      copyFile: updater.STATUS_COPY_FILE,
      logFile: updater.UPDATE_LOG_FILE,
    }));
  `);
  const stateDir = path.join(child.homedir, ".pi", "agent", "state", "pui-update");
  assert.equal(child.homedir, home);
  assert.equal(path.dirname(child.copyFile), stateDir);
  assert.equal(child.copyFile, path.join(stateDir, "last-status.json"));
  assert.equal(child.logFile, path.join(stateDir, "last.log"));
  assert.equal(path.basename(child.statusFile), "pui-update-status.json");
  assert.equal(fs.realpathSync(path.dirname(child.statusFile)), fs.realpathSync(child.temporary));
  assert.equal(fs.readFileSync(child.copyFile, "utf8"), fs.readFileSync(child.statusFile, "utf8"));
  const mirrored = JSON.parse(fs.readFileSync(child.copyFile, "utf8"));
  assert.equal(mirrored.phase, "failed");
  assert.equal(mirrored.result, "failed");
  assert.equal(mirrored.error, "step X");
  assert.match(mirrored.id, /^\d+-\d+$/);
});

test("a failing status mirror never breaks the authoritative status write", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pui-update-mirror-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".pi", "agent", "state"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pi", "agent", "state", "pui-update"), "not a directory");
  const child = runUpdaterChild(home, `
    updater.writeStatus({ phase: "installing", result: null });
    process.stdout.write(JSON.stringify({ statusFile: updater.STATUS_FILE }));
  `);
  assert.equal(JSON.parse(fs.readFileSync(child.statusFile, "utf8")).phase, "installing");
});

test("target apply keeps update evidence in the persistent state directory", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pui-update-evidence-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const extensionRoot = path.join(home, ".pi", "agent", "extensions", "pui-update");
  fs.mkdirSync(extensionRoot, { recursive: true });
  const hashes = {};
  for (const name of ["index.ts", "updater.js", "pui-release.js", "pui-config.js"]) {
    const file = path.join(extensionRoot, name);
    fs.writeFileSync(file, name === "updater.js" ? "module.exports = {};" : `// ${name}`);
    hashes[name] = require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  fs.writeFileSync(path.join(extensionRoot, "manifest.json"), JSON.stringify(certifiedManifest(extensionRoot, hashes)));
  const child = runUpdaterChild(home, `
    globalThis.fetch = async () => { throw new Error("offline network stub"); };
    updater.applyTarget("9.9.9").then(
      () => process.stdout.write(JSON.stringify({ logFile: updater.UPDATE_LOG_FILE, copyFile: updater.STATUS_COPY_FILE, statusFile: updater.STATUS_FILE, message: "", failed: false })),
      (error) => process.stdout.write(JSON.stringify({ logFile: updater.UPDATE_LOG_FILE, copyFile: updater.STATUS_COPY_FILE, statusFile: updater.STATUS_FILE, message: error.message, failed: true })),
    );
  `);
  assert.equal(child.failed, true);
  assert.match(child.message, /offline network stub/);
  assert.equal(fs.readFileSync(child.logFile, "utf8"), "PUI update v1.0.0 -> v9.9.9\n");
  assert.equal(fs.readFileSync(child.copyFile, "utf8"), fs.readFileSync(child.statusFile, "utf8"));
  assert.equal(JSON.parse(fs.readFileSync(child.copyFile, "utf8")).log, child.logFile);
});

test("target apply succeeds only after target validation", async () => {
  const events = [];
  const result = await runTransaction({
    current: "1.0.0",
    target: "1.1.0",
    prepare: async () => events.push("prepare"),
    waitForIdle: async () => events.push("idle"),
    standaloneBusy: async () => false,
    apply: async (version) => events.push(`apply:${version}`),
    validate: async (version) => events.push(`validate:${version}`),
    rollback: async () => events.push("rollback"),
    writeStatus: async (status) => events.push(`status:${status.phase}`),
  });
  assert.equal(result.result, "success");
  assert.equal(result.target, "1.1.0");
  assert.ok(events.indexOf("apply:1.1.0") < events.indexOf("validate:1.1.0"));
  assert.equal(events.includes("rollback"), false);
});

test("a failure before mutation leaves the current composition untouched", async () => {
  let applied = false;
  let rolledBack = false;
  await assert.rejects(
    runTransaction({
      current: "1.0.0",
      target: "1.1.0",
      prepare: async () => { throw new Error("bad release"); },
      waitForIdle: async () => {},
      standaloneBusy: async () => false,
      apply: async () => { applied = true; },
      validate: async () => {},
      rollback: async () => { rolledBack = true; },
      writeStatus: async () => {},
    }),
    /bad release/,
  );
  assert.equal(applied, false);
  assert.equal(rolledBack, false);
});

test("rollback recovers from an old lifecycle script's restart failure only after certified validation", async () => {
  const events = [];
  await rollbackScriptWithRecovery({
    version: "1.2.0",
    runScript: () => { events.push("script"); throw new Error("old VBS restart failed"); },
    ensurePiWebRunning: async () => events.push("relaunch"),
    validateInstalled: async (version) => events.push(`validate:${version}`),
  });
  assert.deepEqual(events, ["script", "relaunch", "validate:1.2.0"]);
});

test("rollback preserves an old lifecycle failure when certified recovery validation also fails", async () => {
  await assert.rejects(rollbackScriptWithRecovery({
    version: "1.2.0",
    runScript: () => { throw new Error("old apply failed"); },
    ensurePiWebRunning: async () => {},
    validateInstalled: async () => { throw new Error("identity mismatch"); },
  }), /old apply failed[\s\S]*identity mismatch/);
});

test("post-mutation failure restores and validates the previous certified release", async () => {
  const events = [];
  const result = await runTransaction({
    current: "1.0.0",
    target: "1.1.0",
    prepare: async () => events.push("prepare"),
    waitForIdle: async () => events.push("idle"),
    standaloneBusy: async () => false,
    apply: async () => { events.push("apply"); throw new Error("integration failed"); },
    validate: async (version) => events.push(`validate:${version}`),
    rollback: async (version) => events.push(`rollback:${version}`),
    writeStatus: async (status) => events.push(`status:${status.phase}`),
  });
  assert.equal(result.result, "rolled-back");
  assert.equal(result.restored, "1.0.0");
  assert.ok(events.includes("rollback:1.0.0"));
  assert.ok(events.includes("validate:1.0.0"));
});

test("rollback validation failure is recovery-required", async () => {
  const result = await runTransaction({
    current: "1.0.0",
    target: "1.1.0",
    prepare: async () => {},
    waitForIdle: async () => {},
    standaloneBusy: async () => false,
    apply: async () => { throw new Error("install failed"); },
    validate: async () => { throw new Error("health failed"); },
    rollback: async () => {},
    writeStatus: async () => {},
  });
  assert.equal(result.result, "recovery-required");
  assert.match(result.error, /health failed/);
});

test("every material post-mutation boundary restores the previous certified release", async () => {
  for (const boundary of ["package-reconciliation", "config-migration", "pi-web-integration", "pi-8782-backport", "extension-replacement", "restart-health", "target-validation"]) {
    let restored = false;
    const result = await runTransaction({
      current: "1.0.0",
      target: "1.1.0",
      prepare: async () => {},
      waitForIdle: async () => {},
      standaloneBusy: async () => false,
      apply: async () => { throw new Error(`injected:${boundary}`); },
      validate: async () => {},
      rollback: async (version) => { restored = version === "1.0.0"; },
      writeStatus: async () => {},
    });
    assert.equal(result.result, "rolled-back", boundary);
    assert.equal(restored, true, boundary);
  }
});
