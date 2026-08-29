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
  assert.match(content, /`@narumitw\/pi-goal` \| 0\.54\.3/);
  assert.match(content, /`@narumitw\/pi-accounts` \| 0\.49\.11/);
  assert.match(content, /`@narumitw\/pi-usage` \| 0\.52\.3/);
  assert.match(content, /`@juicesharp\/rpiv-ask-user-question` \| 2\.7\.1/);
  assert.match(content, /`pi-fff` \| 0\.1\.12/);
  assert.match(content, /`@99percentpeople\/pi-background-tasks` \| 2\.1\.1/);
});

test("v1.1.2 documentation describes every added managed extension", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const components = fs.readFileSync(path.join(repoRoot, "docs", "components.md"), "utf8");
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");

  for (const packageName of ["@juicesharp/rpiv-ask-user-question", "pi-fff", "@99percentpeople/pi-background-tasks"]) {
    assert.match(readme, new RegExp(packageName.replace("/", "\\/")), `README.md: ${packageName}`);
    assert.match(components, new RegExp(packageName.replace("/", "\\/")), `docs/components.md: ${packageName}`);
    assert.match(changelog, new RegExp(packageName.replace("/", "\\/")), `CHANGELOG.md: ${packageName}`);
  }
  for (const content of [readme, components, changelog]) assert.doesNotMatch(content, /pi-permission-system/);
  assert.match(changelog, /^# Changelog\s+## v1\.1\.2/m);
  assert.match(changelog, /disabled.*pi-fff.*agentTools/i);
  assert.match(changelog, /^## v1\.0\.4$/m);
});

test("documentation describes managed account switching", () => {
  for (const file of ["README.md", "docs/components.md", "CHANGELOG.md"]) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.match(content, /@narumitw\/pi-accounts/, file);
  }
});

test("documentation describes usage tracking", () => {
  for (const file of ["README.md", "docs/components.md", "CHANGELOG.md"]) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.match(content, /@narumitw\/pi-usage/, file);
  }
});

test("documentation describes PUI-managed structured-question guidance", () => {
  const components = fs.readFileSync(path.join(repoRoot, "docs", "components.md"), "utf8");
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  assert.match(components, /~\/\.config\/rpiv-ask-user-question\/config\.json/);
  assert.match(components, /guidance\.(?:description|promptSnippet|promptGuidelines)/);
  assert.match(components, /uninstall.*exact.*managed.*guidance/i);
  assert.match(changelog, /structured-question guidance/i);
});

test("documentation describes configurable fuzzy subagent mappings and update preservation", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const components = fs.readFileSync(path.join(repoRoot, "docs/components.md"), "utf8");
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  for (const content of [readme, components, changelog]) {
    assert.match(content, /~\/\.config\/pui\/subagents\.json/);
    assert.match(content, /fuzzy/i);
  }
  assert.match(components, /_pui\.defaultMappings/);
  assert.match(components, /changed or deleted is preserved/i);
  assert.match(changelog, /without restoring mappings the user deleted/i);
});

test("documentation describes the owned background-task prompt patch and native recovery", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const components = fs.readFileSync(path.join(repoRoot, "docs", "components.md"), "utf8");
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  assert.match(readme, /background-tasks[\s\S]*node-pty.*during install and update/i);
  assert.match(readme, /node-pty.*during install and update/i);
  assert.match(components, /27 overlapping prompt guidelines/);
  assert.match(components, /index\.min\.js\.pui-original/);
  assert.match(components, /index\.min\.js\.pui-manifest\.json/);
  assert.match(components, /update transactions back up the bundle, original, and ownership manifest/i);
  assert.match(components, /uninstall restores.*only while.*PUI-owned/i);
  assert.match(components, /node-pty.*approve\/rebuild/i);
  assert.match(changelog, /background-tasks.*27 overlapping system-prompt guidelines/i);
  assert.match(changelog, /node-pty.*fail closed/i);
});

test("documentation describes the temporary Pi #8782 Pi Web-only backport", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
  const components = fs.readFileSync(path.join(repoRoot, "docs", "components.md"), "utf8");
  const verification = fs.readFileSync(path.join(repoRoot, "docs", "upstream-verification.md"), "utf8");
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  assert.match(readme, /Pi #8782|standalone.*stock.*Pi Web/i);
  assert.match(agents, /pui-pi-8782-backport\.js[\s\S]*temporary[\s\S]*retir/i);
  assert.match(components, /pui-pi-8782-backport\.js/);
  assert.match(components, /standalone.*stock.*0\.84\.3.*Pi Web/i);
  assert.match(verification, /Pi #8782 backport/);
  assert.match(changelog, /Pi #8782.*temporary/i);
});

test("documentation describes the hybrid Playwright MCP policy", () => {
  for (const file of ["docs/components.md", "docs/upstream-verification.md", "CHANGELOG.md"]) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.match(content, /browser_navigate/, `${file}: direct tool example`);
    assert.match(content, /prox(?:y|ied)/i, `${file}: proxy policy`);
  }
});
