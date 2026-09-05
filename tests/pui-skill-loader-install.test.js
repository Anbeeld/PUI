const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const {
  guardSnapshot,
  installExtension,
  removeExtension,
  restoreSnapshot,
  snapshot,
  verifyExtension,
} = require(path.join(repoRoot, "lib", "pui-skill-loader-extension.js"));

function target(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-skill-loader-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "pui-skill-loader");
}

test("skill loader installs and verifies its exact owned shape", (t) => {
  const destination = target(t);
  const manifest = installExtension({ repoRoot, target: destination });
  assert.equal(manifest.owner, "PUI");
  assert.deepEqual(verifyExtension({ repoRoot, target: destination }), { ok: true, manifest });
  assert.deepEqual(fs.readdirSync(destination).sort(), ["core.ts", "index.ts", "manifest.json", "package.json", "pui-extension-transaction.cjs"]);
});

test("skill loader install refuses an unowned existing target", (t) => {
  const destination = target(t);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "index.ts"), "user extension", "utf8");
  assert.throws(() => installExtension({ repoRoot, target: destination }), /not PUI-owned/);
  assert.equal(fs.readFileSync(path.join(destination, "index.ts"), "utf8"), "user extension");
});

test("skill loader update replaces only a verified PUI-owned target", (t) => {
  const destination = target(t);
  installExtension({ repoRoot, target: destination });
  const manifestFile = path.join(destination, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.files["index.ts"] = "0".repeat(64);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assert.throws(() => installExtension({ repoRoot, target: destination }), /not PUI-owned/);
});

test("skill loader uninstall preserves modified content", (t) => {
  const destination = target(t);
  installExtension({ repoRoot, target: destination });
  fs.appendFileSync(path.join(destination, "core.ts"), "\n// user change\n");
  assert.deepEqual(removeExtension(destination), { action: "preserved", reason: "modified" });
  assert.equal(fs.existsSync(destination), true);
});

test("skill loader snapshot restores an introducing update", (t) => {
  const destination = target(t);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-skill-loader-snapshot-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  assert.equal(snapshot(stateDir, destination).ok, true);
  installExtension({ repoRoot, target: destination });
  assert.equal(restoreSnapshot(stateDir, destination).ok, true);
  assert.equal(fs.existsSync(destination), false);
});

test("skill loader transaction guard restores rollback and commits success", (t) => {
  for (const result of ["rolled-back", "success"]) {
    const destination = target(t);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `pui-skill-loader-guard-${result}-`));
    const statusFile = path.join(stateDir, "status.json");
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    snapshot(stateDir, destination);
    installExtension({ repoRoot, target: destination });
    fs.writeFileSync(statusFile, JSON.stringify({ id: `tx-${result}`, target: "1.3.0", result }));
    assert.equal(guardSnapshot(stateDir, "1.3.0", { target: destination, statusFile, timeoutMs: 100 }).action,
      result === "success" ? "committed" : "restored");
    assert.equal(fs.existsSync(destination), result === "success");
  }
});

test("skill loader uninstall removes an unchanged owned extension", (t) => {
  const destination = target(t);
  installExtension({ repoRoot, target: destination });
  assert.deepEqual(removeExtension(destination), { action: "removed" });
  assert.equal(fs.existsSync(destination), false);
});
