const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const {
  installExtension,
  removeExtension,
  verifyExtension,
} = require(path.join(repoRoot, "lib", "pui-update-extension.js"));

test("installed update extension is the authoritative release identity", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-extension-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, "extensions", "pui-update");

  const manifest = installExtension({ repoRoot, target });
  assert.equal(manifest.puiVersion, require(path.join(repoRoot, "package.json")).version);
  assert.equal(manifest.owner, "PUI");
  assert.deepEqual(verifyExtension({ repoRoot, target }), { ok: true, manifest });
  assert.equal(fs.existsSync(path.join(target, "index.ts")), true);
  assert.equal(fs.existsSync(path.join(target, "updater.js")), true);
});

test("uninstall removes only an unmodified PUI-owned extension", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-extension-remove-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, "pui-update");
  installExtension({ repoRoot, target });
  fs.appendFileSync(path.join(target, "index.ts"), "\n// user change\n");
  assert.deepEqual(removeExtension(target), { action: "preserved", reason: "modified" });
  assert.equal(fs.existsSync(target), true);
});

test("update replacement restores the complete PUI-owned extension shape", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-extension-replace-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, "pui-update");
  installExtension({ repoRoot, target });
  fs.writeFileSync(path.join(target, "unexpected.txt"), "drift");
  installExtension({ repoRoot, target });
  assert.equal(fs.existsSync(path.join(target, "unexpected.txt")), false);
  assert.equal(verifyExtension({ repoRoot, target }).ok, true);
});

test("uninstall preserves an extension whose identity manifest was changed", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-extension-manifest-drift-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, "pui-update");
  installExtension({ repoRoot, target });
  const manifestFile = path.join(target, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.puiVersion = "9.9.9";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  assert.deepEqual(removeExtension(target), { action: "preserved", reason: "modified" });
});
