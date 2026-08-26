const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const docs = [
  "README.md",
  ...fs.readdirSync(path.join(repoRoot, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`),
];

test("documentation has no unresolved placeholders or stale plan references", () => {
  for (const file of docs) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(content, /<your-repo-url>|\bTBD\b|\bTODO\b|plan §/i, file);
  }
});

test("all relative Markdown links resolve", () => {
  for (const file of docs) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    for (const match of content.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0];
      assert.equal(fs.existsSync(path.resolve(path.dirname(path.join(repoRoot, file)), target)), true, `${file}: ${target}`);
    }
  }
});

test("documented upstream versions match stack package count", () => {
  const content = fs.readFileSync(path.join(repoRoot, "docs", "upstream-verification.md"), "utf8");
  const stack = require(path.join(repoRoot, "stack.json"));
  assert.match(content, new RegExp(`All ${Object.keys(stack.upstream).length} upstream packages`));
  assert.match(content, /`@narumitw\/pi-goal` \| 0\.54\.0/);
  assert.match(content, /`@juicesharp\/rpiv-ask-user-question` \| 2\.7\.1/);
  assert.match(content, /`pi-fff` \| 0\.1\.12/);
});

test("v1.0.4 documentation describes every added managed extension", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const components = fs.readFileSync(path.join(repoRoot, "docs", "components.md"), "utf8");
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");

  for (const packageName of ["@juicesharp/rpiv-ask-user-question", "pi-fff"]) {
    assert.match(readme, new RegExp(packageName.replace("/", "\\/")), `README.md: ${packageName}`);
    assert.match(components, new RegExp(packageName.replace("/", "\\/")), `docs/components.md: ${packageName}`);
    assert.match(changelog, new RegExp(packageName.replace("/", "\\/")), `CHANGELOG.md: ${packageName}`);
  }
  for (const content of [readme, components, changelog]) assert.doesNotMatch(content, /pi-permission-system/);
  assert.match(changelog, /^# Changelog\s+## v1\.0\.5/m);
  assert.match(changelog, /^## v1\.0\.4$/m);
});

test("documentation describes the hybrid Playwright MCP policy", () => {
  for (const file of ["docs/components.md", "docs/upstream-verification.md", "CHANGELOG.md"]) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.match(content, /browser_navigate/, `${file}: direct tool example`);
    assert.match(content, /prox(?:y|ied)/i, `${file}: proxy policy`);
  }
});
