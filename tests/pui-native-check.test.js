const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { verify, ensure, rebuildNodePty, backupNpmProject, nodePtyDir, piAgentNpmRoot, platformTag } =
  require("../lib/pui-native-check.js");

// Build a fake pi-agent npm root with a stub node-pty that either loads or fails.
function fakeRoot({ loadable = true, nested = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-native-"));
  const dir = nested
    ? path.join(root, "node_modules", "@99percentpeople", "pi-background-tasks", "node_modules", "node-pty")
    : path.join(root, "node_modules", "node-pty");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-extensions", private: true }));
  if (nested) {
    const backgroundDir = path.join(root, "node_modules", "@99percentpeople", "pi-background-tasks");
    fs.writeFileSync(
      path.join(backgroundDir, "package.json"),
      JSON.stringify({ name: "@99percentpeople/pi-background-tasks", version: "2.1.1" }),
    );
  }
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "node-pty", version: "1.2.0-beta.14", main: "index.js" }),
  );
  fs.writeFileSync(
    path.join(dir, "index.js"),
    loadable
      ? "module.exports = { spawn: () => {} };\n"
      : "module.exports = require('./missing.node');\n",
  );
  return root;
}

test("verify reports ok when node-pty loads", () => {
  const root = fakeRoot({ loadable: true });
  const r = verify(root);
  assert.equal(r.ok, true);
  assert.equal(r.action, "loaded");
  assert.equal(r.platform, platformTag());
});

test("verify reports failure when node-pty cannot load", () => {
  const root = fakeRoot({ loadable: false });
  const r = verify(root);
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, "string");
  assert.equal(r.platform, platformTag());
});

test("verify follows a node-pty nested under background tasks", () => {
  const root = fakeRoot({ loadable: true, nested: true });
  assert.equal(
    nodePtyDir(root),
    path.join(root, "node_modules", "@99percentpeople", "pi-background-tasks", "node_modules", "node-pty"),
  );
  assert.equal(verify(root).ok, true);
});

test("rebuildNodePty approves node-pty scripts and rebuilds the package", () => {
  const root = fakeRoot({ loadable: false });
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "" };
  };
  const r = rebuildNodePty(root, runner);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  const npmArgs = (command) => {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (process.platform === "win32" && fs.existsSync(npmCli)) return [npmCli, command, "node-pty", "--prefix", root];
    if (process.platform === "win32") return ["/d", "/s", "/c", "npm.cmd", command, "node-pty", "--prefix", root];
    return [command, "node-pty", "--prefix", root];
  };
  assert.deepEqual(calls[0].args, npmArgs("approve-scripts"));
  assert.deepEqual(calls[1].args, npmArgs("rebuild"));
  const expectedCommand = process.platform === "win32"
    ? (fs.existsSync(path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")) ? process.execPath : (process.env.ComSpec || "cmd.exe"))
    : "npm";
  assert.equal(calls[0].command, expectedCommand);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[1].options.cwd, root);
  const backups = fs.readdirSync(root).filter((name) => name.startsWith("package.json.pui-backup-"));
  assert.equal(backups.length, 1, "approval mutation is backed up");
});

test("ensure re-verifies node-pty after a successful rebuild", () => {
  const root = fakeRoot({ loadable: false });
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("rebuild")) {
      fs.writeFileSync(path.join(nodePtyDir(root), "index.js"), "module.exports = { spawn: () => {} };\n");
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const r = ensure(root, runner);
  assert.equal(r.ok, true);
  assert.equal(r.action, "rebuilt");
  assert.equal(calls.length, 2);
});

test("verify reports failure when node-pty is not installed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-native-"));
  const r = verify(root);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not installed/);
});

test("backupNpmProject rejects invalid npm metadata before approval", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-native-"));
  fs.writeFileSync(path.join(root, "package.json"), "{invalid");
  const r = backupNpmProject(root);
  assert.equal(r.ok, false);
  assert.match(r.reason, /invalid npm project metadata/);
  assert.equal(fs.readdirSync(root).filter((name) => name.startsWith("package.json.pui-backup-")).length, 0);
});

test("ensure returns loaded when node-pty already loads", () => {
  const root = fakeRoot({ loadable: true });
  const r = ensure(root);
  assert.equal(r.ok, true);
  assert.equal(r.action, "loaded");
});

test("ensure reports an actionable failure when approval or rebuild cannot restore the binding", () => {
  const root = fakeRoot({ loadable: false });
  const runner = () => ({ status: 1, stdout: "", stderr: "rebuild failed" });
  const r = ensure(root, runner);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "node-pty native binding missing");
  assert.match(r.hint, /build tools/);
  assert.match(r.hint, /PUI install or update entry point/);
  assert.equal(r.platform, platformTag());
});

test("default paths point at the pi agent npm root", () => {
  assert.equal(piAgentNpmRoot(), path.join(os.homedir(), ".pi", "agent", "npm"));
  assert.equal(nodePtyDir(), path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "node-pty"));
});