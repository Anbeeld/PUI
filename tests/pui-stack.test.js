const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const reader = path.join(repoRoot, "lib", "pui-stack.js");
const stack = path.join(repoRoot, "stack.json");

function read(key) {
  return spawnSync(process.execPath, [reader, stack, key], { encoding: "utf8" });
}

test("stack reader emits strings without JSON quotes", () => {
  const result = read("configPaths.piSettings");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "~/.pi/agent/settings.json");
});

test("stack reader emits MCP server names as literal object keys", () => {
  const result = read("mcp.serverName");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "playwright");
});

test("stack reader emits objects and arrays as JSON", () => {
  const result = read("defaultTools");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
});

test("stack reader rejects missing keys", () => {
  const result = read("configPaths.missing");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing key/i);
});
