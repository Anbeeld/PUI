const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "..");
const {
  chooseStableUpdate,
  detachedSpawnOptions,
  backupBackgroundTaskFilesForStacks,
  backupSubagentFilesForStacks,
  backupConfigFiles,
  backupConfigFilesForStacks,
  restoreConfigFiles,
  runTransaction,
  scriptEnvironment,
  isStandalonePiCommand,
  isPiWebProcess,
  manualUpdateGuidance,
  piWebIdle,
  piWebLaunchSpec,
} = require(path.join(repoRoot, "lib", "pui-updater.js"));

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
    ["piSettings", "piWebAccess", "mcpShared", "piFffFeatures", "piGoal", "askUserQuestion", "puiSubagents"]
      .map((key) => [key, path.join(temp, `${key}.json`)]),
  );
  for (const file of Object.values(configPaths)) fs.writeFileSync(file, JSON.stringify({ file }));

  const backups = backupConfigFiles({
    configPaths,
    askUserQuestion: { configRelativePath: "rpiv-ask-user-question/config.json" },
  }, path.join(temp, "backups"));

  assert.deepEqual(new Set(backups.map((entry) => entry.file)), new Set(Object.values(configPaths)));
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

test("Pi Web idle verification fails closed when activity cannot be read", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => { throw new Error("connection refused"); };
  await assert.rejects(piWebIdle(), /Could not verify Pi Web idle state/);
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


test("restart relaunch reuses the Windows autostart VBS launcher when present", () => {
  const vbs = path.join("appdata", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "pui-piweb.vbs");
  const spec = piWebLaunchSpec({ platform: "win32", appData: "appdata", env: {}, existsSync: (p) => p === vbs });
  assert.equal(spec.file, "wscript.exe");
  assert.deepEqual(spec.args, [vbs]);
  assert.equal(spec.stopsExisting, false);
});

test("restart relaunch without autostart falls back to a cmd shim that skips pi-web's version check", () => {
  const spec = piWebLaunchSpec({ platform: "win32", appData: "appdata", env: {}, existsSync: () => false });
  assert.equal(spec.file, "cmd.exe");
  assert.deepEqual(spec.args, ["/d", "/s", "/c", "pi-web --no-open"]);
  assert.equal(spec.env.PI_WEB_SKIP_VERSION_CHECK, "1");
  assert.equal(spec.stopsExisting, false);
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
