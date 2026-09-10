const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const helper = () => require("../lib/pui-model-policy-extension.js");
function target(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-model-policy-extension-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "pui-model-policy");
}

test("installer creates, verifies, replaces, and removes exact owned content", (t) => {
  const live = target(t);
  helper().installExtension({ repoRoot, target: live });
  assert.equal(helper().verifyExtension({ repoRoot, target: live }).ok, true);
  assert.deepEqual(fs.readdirSync(live).sort(), ["core.ts", "index.ts", "manifest.json", "package.json"]);
  helper().installExtension({ repoRoot, target: live });
  assert.equal(helper().removeExtension(live).action, "removed");
});

test("installer and uninstall preserve unowned or drifted content", (t) => {
  const live = target(t);
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, "index.ts"), "user content");
  assert.throws(() => helper().installExtension({ repoRoot, target: live }), /not PUI-owned/);
  assert.equal(helper().removeExtension(live).action, "preserved");

  const owned = target(t);
  helper().installExtension({ repoRoot, target: owned });
  fs.appendFileSync(path.join(owned, "core.ts"), "\n// drift\n");
  assert.equal(helper().verifyExtension({ repoRoot, target: owned }).ok, false);
  assert.equal(helper().removeExtension(owned).action, "preserved");
});
