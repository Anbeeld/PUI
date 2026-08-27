#!/usr/bin/env node
// Verify and repair the native node-pty dependency used by
// @99percentpeople/pi-background-tasks.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { backupFile, readJsonSafe } = require("./pui-config.js");

const BACKGROUND_TASKS_PACKAGE = "@99percentpeople/pi-background-tasks";

function piAgentNpmRoot() {
  return path.join(os.homedir(), ".pi", "agent", "npm");
}

function nodePtyDir(root = piAgentNpmRoot()) {
  try {
    const backgroundPackage = require.resolve(`${BACKGROUND_TASKS_PACKAGE}/package.json`, { paths: [root] });
    const backgroundDir = path.dirname(backgroundPackage);
    try {
      return path.dirname(require.resolve("node-pty/package.json", { paths: [backgroundDir] }));
    } catch {
      return path.join(backgroundDir, "node_modules", "node-pty");
    }
  } catch {
    // The package may not be installed yet; retain the normal hoisted path for
    // diagnostics and for test fixtures that model the dependency directly.
    return path.join(root, "node_modules", "node-pty");
  }
}

function platformTag() {
  return `${process.platform}-${process.arch}`;
}

function verify(root = piAgentNpmRoot()) {
  const dir = nodePtyDir(root);
  if (!fs.existsSync(dir)) {
    return { ok: false, reason: "node-pty not installed", platform: platformTag() };
  }
  try {
    require(dir);
    return { ok: true, action: "loaded", platform: platformTag() };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      platform: platformTag(),
    };
  }
}

function npmCliPath() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  candidates.push(path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"));
  for (const entry of String(process.env.PATH || "").split(path.delimiter)) {
    if (!entry) continue;
    candidates.push(path.join(entry, "node_modules", "npm", "bin", "npm-cli.js"));
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function npmInvocation(args) {
  if (process.platform === "win32") {
    const npmCli = npmCliPath();
    return npmCli ? { command: process.execPath, args: [npmCli, ...args] } : null;
  }
  return { command: "npm", args };
}

function runNpm(root, args, runner) {
  const invocation = npmInvocation(args);
  if (!invocation) return { status: null, error: "npm CLI not found" };
  return runner(invocation.command, invocation.args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
}

function backupNpmProject(root) {
  const file = path.join(root, "package.json");
  const parsed = readJsonSafe(file);
  if (!parsed.ok) return { ok: false, reason: `invalid npm project metadata: ${parsed.error}` };
  try {
    return { ok: true, backup: backupFile(file).backup };
  } catch (error) {
    return {
      ok: false,
      reason: `could not back up npm project metadata: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// npm 11 defers lifecycle scripts until a dependency is explicitly approved.
// Approval is intentionally limited to node-pty, which is the native dependency
// PUI added through pi-background-tasks. Older npm versions may not implement
// approve-scripts; their rebuild command still runs the package lifecycle script.
function rebuildNodePty(root = piAgentNpmRoot(), runner = spawnSync) {
  const dir = nodePtyDir(root);
  if (!fs.existsSync(dir)) {
    return { ok: false, reason: "node-pty not installed" };
  }
  const backup = backupNpmProject(root);
  if (!backup.ok) return backup;

  const approval = runNpm(root, ["approve-scripts", "node-pty", "--prefix", root], runner);
  const rebuild = runNpm(root, ["rebuild", "node-pty", "--prefix", root], runner);
  return {
    ok: rebuild.status === 0,
    approvalStatus: approval.status,
    rebuildStatus: rebuild.status,
    backup: backup.backup,
  };
}

function ensure(root = piAgentNpmRoot(), runner = spawnSync) {
  const first = verify(root);
  if (first.ok) return first;

  const rebuild = rebuildNodePty(root, runner);
  const second = verify(root);
  if (second.ok) return { ok: true, action: "rebuilt", platform: second.platform };

  return {
    ok: false,
    reason: "node-pty native binding missing",
    platform: platformTag(),
    rebuildStatus: rebuild.rebuildStatus,
    hint:
      "PUI could not load node-pty for this platform/arch. Install build tools " +
      "(Python 3 and a C++ compiler, or Visual Studio Build Tools on Windows), " +
      "then rerun the PUI install or update entry point so it can approve and rebuild " +
      "the managed native dependency.",
  };
}

function main(argv) {
  const command = argv[0] || "verify";
  const root = argv[1] || piAgentNpmRoot();
  if (command === "verify") {
    const result = verify(root);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  if (command === "ensure") {
    const result = ensure(root);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }
  console.error("Usage: pui-native-check.js [verify|ensure] [pi-agent-npm-root]");
  return 64;
}

module.exports = {
  verify,
  ensure,
  rebuildNodePty,
  nodePtyDir,
  piAgentNpmRoot,
  platformTag,
  backupNpmProject,
};
if (require.main === module) process.exitCode = main(process.argv.slice(2));
