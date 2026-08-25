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
});
