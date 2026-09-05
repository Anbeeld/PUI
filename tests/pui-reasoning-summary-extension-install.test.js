const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const helperPath = path.join(repoRoot, "lib", "pui-reasoning-summary-extension.js");

function helper() { return require(helperPath); }
function target(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-reasoning-summary-extension-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "pui-reasoning-summary");
}

test("installer creates and verifies the exact owned extension", (t) => {
  const live = target(t);
  const { installExtension, verifyExtension } = helper();
  installExtension({ repoRoot, target: live });
  assert.equal(verifyExtension({ repoRoot, target: live }).ok, true);
  assert.deepEqual(fs.readdirSync(live).sort(), ["core.ts", "index.ts", "manifest.json", "package.json"]);
});

test("installer replaces an intact prior PUI-owned extension", (t) => {
  const live = target(t);
  const { installExtension, verifyExtension } = helper();
  installExtension({ repoRoot, target: live });
  installExtension({ repoRoot, target: live });
  assert.equal(verifyExtension({ repoRoot, target: live }).ok, true);
});

test("installer refuses to replace unowned or modified content", (t) => {
  const live = target(t);
  const { installExtension } = helper();
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, "index.ts"), "user content");
  assert.throws(() => installExtension({ repoRoot, target: live }), /not PUI-owned/);
});

test("modified manifest file ownership is never accepted", (t) => {
  const live = target(t);
  const { installExtension, removeExtension, verifyExtension } = helper();
  installExtension({ repoRoot, target: live });
  const manifestFile = path.join(live, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.files["extra.ts"] = "0".repeat(64);
  const core = { owner: manifest.owner, schemaVersion: manifest.schemaVersion, puiVersion: manifest.puiVersion, files: manifest.files };
  manifest.identityHash = require("node:crypto").createHash("sha256").update(JSON.stringify(core)).digest("hex");
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(verifyExtension({ repoRoot, target: live }).ok, false);
  assert.throws(() => installExtension({ repoRoot, target: live }), /not PUI-owned/);
  assert.equal(removeExtension(live).action, "preserved");
});

test("uninstall removes intact owned content and preserves drift", (t) => {
  const clean = target(t);
  const changed = target(t);
  const { installExtension, removeExtension } = helper();
  installExtension({ repoRoot, target: clean });
  assert.equal(removeExtension(clean).action, "removed");
  assert.equal(fs.existsSync(clean), false);

  installExtension({ repoRoot, target: changed });
  fs.appendFileSync(path.join(changed, "core.ts"), "\n// user change\n");
  assert.equal(removeExtension(changed).action, "preserved");
  assert.equal(fs.existsSync(changed), true);
});
