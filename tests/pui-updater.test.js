const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "..");
const {
  chooseStableUpdate,
  detachedSpawnOptions,
  backupConfigFiles,
  backupConfigFilesForStacks,
  restoreConfigFiles,
  runTransaction,
  scriptEnvironment,
  isStandalonePiCommand,
  piWebIdle,
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
  for (const boundary of ["package-reconciliation", "config-migration", "pi-web-integration", "extension-replacement", "restart-health", "target-validation"]) {
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
