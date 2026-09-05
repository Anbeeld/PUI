const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const helperPath = path.join(repoRoot, "lib", "pui-session-title-extension.js");
function helper() { return require(helperPath); }
function target(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-title-extension-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "pui-session-title");
}

test("session-title installer creates and verifies the exact owned extension", (t) => {
  const live = target(t);
  const { installExtension, verifyExtension } = helper();
  installExtension({ repoRoot, target: live });
  assert.equal(verifyExtension({ repoRoot, target: live }).ok, true);
  assert.deepEqual(fs.readdirSync(live).sort(), ["core.ts", "index.ts", "manifest.json", "package.json"]);
});

test("session-title installer replaces only intact PUI-owned content", (t) => {
  const live = target(t);
  const { installExtension, verifyExtension } = helper();
  installExtension({ repoRoot, target: live });
  installExtension({ repoRoot, target: live });
  assert.equal(verifyExtension({ repoRoot, target: live }).ok, true);
  fs.appendFileSync(path.join(live, "core.ts"), "\nmodified");
  assert.throws(() => installExtension({ repoRoot, target: live }), /not PUI-owned/);
});

test("session-title replacement rolls back when old-backup cleanup fails", (t) => {
  const live = target(t);
  const { installExtension } = helper();
  installExtension({ repoRoot, target: live });
  const oldIndex = fs.readFileSync(path.join(live, "index.ts"), "utf8");
  const injectedFs = {
    ...fs,
    rmSync(file, options) {
      if (String(file).includes(".replace-")) throw new Error("backup cleanup failed");
      return fs.rmSync(file, options);
    },
  };
  assert.throws(() => installExtension({ repoRoot, target: live, fs: injectedFs }), /backup cleanup failed/);
  assert.equal(fs.readFileSync(path.join(live, "index.ts"), "utf8"), oldIndex);
  assert.equal(fs.readdirSync(live).includes(".replace-"), false);
});

test("session-title snapshot restores an introducing update", (t) => {
  const live = target(t);
  const state = `${live}-snapshot`;
  const { installExtension, restoreSnapshot, snapshot } = helper();
  snapshot(state, live);
  installExtension({ repoRoot, target: live });
  restoreSnapshot(state, live);
  assert.equal(fs.existsSync(live), false);
});

test("session-title snapshot restore preserves post-snapshot drift", (t) => {
  const live = target(t);
  const state = `${live}-snapshot`;
  const { installExtension, restoreSnapshot, snapshot } = helper();
  snapshot(state, live);
  installExtension({ repoRoot, target: live });
  fs.appendFileSync(path.join(live, "core.ts"), "\nuser change");

  const result = restoreSnapshot(state, live);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "target-drift");
  assert.match(fs.readFileSync(path.join(live, "core.ts"), "utf8"), /user change/);
});

test("session-title uninstall removes owned content and preserves drift", (t) => {
  const clean = target(t);
  const changed = target(t);
  const { installExtension, removeExtension } = helper();
  installExtension({ repoRoot, target: clean });
  assert.equal(removeExtension(clean).action, "removed");
  installExtension({ repoRoot, target: changed });
  fs.writeFileSync(path.join(changed, "extra.ts"), "user content");
  assert.equal(removeExtension(changed).action, "preserved");
  assert.equal(fs.existsSync(changed), true);
});
