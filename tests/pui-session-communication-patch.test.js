const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-communication-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".next", "server", "chunks"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@agegr/pi-web", version: "0.8.11" }));
  fs.writeFileSync(path.join(root, ".next", "server", "chunks", "6429.js"), 'prefix;function B(){return globalThis.__piSessions}function I(a){return B().get(a)}function K(){return []}async function P(a,b,c,d={}){return{session:B().get(a),realSessionId:a}}d()}catch(a){d(a)}})},71069:suffix');
  return root;
}

test("patch installs a versioned broker sidecar and exact owned transform", (t) => {
  const root = fixture(t);
  const patch = require("../lib/pui-session-communication-patch.js");
  assert.equal(patch.apply(repoRoot, root).ok, true);
  assert.equal(patch.verify(repoRoot, root).ok, true);
  assert.match(fs.readFileSync(path.join(root, ".next", "server", "chunks", "6429.js"), "utf8"), /pui-session-communication:broker-v1/);
  assert.equal(fs.readFileSync(path.join(root, ".next", "server", "pui-session-broker.cjs"), "utf8"), fs.readFileSync(path.join(repoRoot, "assets", "pui-session-broker.cjs"), "utf8"));
});

test("patch is idempotent, detects drift, and only restores intact ownership", (t) => {
  const root = fixture(t);
  const patch = require("../lib/pui-session-communication-patch.js");
  const original = fs.readFileSync(path.join(root, ".next", "server", "chunks", "6429.js"), "utf8");
  patch.apply(repoRoot, root);
  assert.equal(patch.apply(repoRoot, root).action, "already-patched");
  fs.appendFileSync(path.join(root, ".next", "server", "chunks", "6429.js"), "drift");
  assert.equal(patch.verify(repoRoot, root).reason, "installed-drift");
  assert.equal(patch.remove(root).action, "preserved");
  assert.notEqual(fs.readFileSync(path.join(root, ".next", "server", "chunks", "6429.js"), "utf8"), original);
});

test("remove restores the original chunk and removes only owned sidecars", (t) => {
  const root = fixture(t);
  const patch = require("../lib/pui-session-communication-patch.js");
  const chunk = path.join(root, ".next", "server", "chunks", "6429.js");
  const original = fs.readFileSync(chunk, "utf8");
  patch.apply(repoRoot, root);
  assert.equal(patch.remove(root).action, "restored");
  assert.equal(fs.readFileSync(chunk, "utf8"), original);
  assert.equal(fs.existsSync(path.join(root, ".next", "server", "pui-session-broker.cjs")), false);
});

test("snapshot restores all broker patch artifacts", (t) => {
  const root = fixture(t);
  const patch = require("../lib/pui-session-communication-patch.js");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-communication-snapshot-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  patch.apply(repoRoot, root);
  assert.equal(patch.snapshot(state, root).ok, true);
  patch.remove(root);
  assert.equal(patch.restoreSnapshot(state, root).ok, true);
  assert.equal(patch.verify(repoRoot, root).ok, true);
});

test("snapshot restore preserves artifacts changed or deleted after the snapshot", (t) => {
  const root = fixture(t);
  const patch = require("../lib/pui-session-communication-patch.js");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-communication-drift-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  patch.apply(repoRoot, root);
  assert.equal(patch.snapshot(state, root).ok, true);
  const chunk = path.join(root, ".next", "server", "chunks", "6429.js");
  fs.appendFileSync(chunk, "live-change");
  const sidecar = path.join(root, ".next", "server", "pui-session-broker.cjs");
  fs.unlinkSync(sidecar);
  assert.equal(patch.restoreSnapshot(state, root).ok, true);
  assert.match(fs.readFileSync(chunk, "utf8"), /live-change$/);
  assert.equal(fs.existsSync(sidecar), false);
});

test("a later invocation recovers an interrupted artifact transaction", (t) => {
  const root = fixture(t);
  const patch = require("../lib/pui-session-communication-patch.js");
  const chunk = path.join(root, ".next", "server", "chunks", "6429.js");
  const original = fs.readFileSync(chunk, "utf8");
  assert.equal(patch.beginArtifactTransaction(root).ok, true);
  fs.writeFileSync(chunk, "partial write");
  fs.writeFileSync(path.join(root, ".next", "server", "pui-session-broker.cjs"), "partial sidecar");

  assert.equal(patch.apply(repoRoot, root).ok, true);
  assert.equal(patch.verify(repoRoot, root).ok, true);
  assert.equal(fs.readFileSync(`${chunk}.pui-session-original`, "utf8"), original);
});

test("spawn-guard CLI distinguishes a direct update from a started guard", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-communication-guard-cli-"));
  const state = path.join(temp, "snapshot");
  fs.mkdirSync(state);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "lib", "pui-session-communication-patch.js"),
    "spawn-guard",
    state,
    "1.3.2",
    path.join(temp, "pi-web"),
  ], { encoding: "utf8", env: { ...process.env, TEMP: temp, TMP: temp } });

  assert.equal(result.status, 75, result.stderr || result.stdout);
  assert.match(result.stdout, /"action":"not-needed"/);
  assert.equal(fs.existsSync(path.join(state, "guard-ready")), false);
});

test("spawn-guard CLI reports an existing transaction guard distinctly", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-session-communication-guard-cli-"));
  const state = path.join(temp, "snapshot");
  fs.mkdirSync(state);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const id = `test-${process.pid}`;
  fs.writeFileSync(path.join(temp, "pui-update.lock"), JSON.stringify({ id, pid: process.pid }));
  fs.writeFileSync(path.join(temp, "pui-update-status.json"), JSON.stringify({ id, target: "1.3.2", step: "1.3.2" }));
  fs.writeFileSync(path.join(temp, "pui-session-communication-guard.json"), JSON.stringify({ id, pid: process.pid }));
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "lib", "pui-session-communication-patch.js"),
    "spawn-guard",
    state,
    "1.3.2",
    path.join(temp, "pi-web"),
  ], { encoding: "utf8", env: { ...process.env, TEMP: temp, TMP: temp } });

  assert.equal(result.status, 76, result.stderr || result.stdout);
  assert.match(result.stdout, /"action":"already-guarded"/);
});

test("patch rejects wrong package versions and changed anchors", (t) => {
  const root = fixture(t);
  const patch = require("../lib/pui-session-communication-patch.js");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@agegr/pi-web", version: "0.8.12" }));
  assert.equal(patch.apply(repoRoot, root).reason, "version-mismatch");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@agegr/pi-web", version: "0.8.11" }));
  fs.writeFileSync(path.join(root, ".next", "server", "chunks", "6429.js"), "changed");
  assert.equal(patch.apply(repoRoot, root).reason, "anchor-missing");
});
