const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

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
  assert.equal(release.version, "1.0.3");
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

test("CI validates the release manifest and tag/version agreement", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "tests.yml"), "utf8");
  assert.match(workflow, /npm run release:validate/);
  assert.match(workflow, /GITHUB_REF_TYPE/);
  assert.match(workflow, /package\.json/);
});
