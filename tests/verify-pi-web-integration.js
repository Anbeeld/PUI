#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { applyIntegration, removeIntegration, verifyIntegration } = require("../lib/pui-web-integration.js");

const repoRoot = path.resolve(__dirname, "..");
const stack = require("../stack.json");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-pi-web-fixture-"));
try {
  const npmArguments = ["pack", `${stack.upstream.gui.npm}@${stack.upstream.gui.version}`, "--pack-destination", temp, "--silent"];
  const npmExecPath = process.env.npm_execpath;
  const packed = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, ...npmArguments], { encoding: "utf8" })
    : spawnSync("npm", npmArguments, { encoding: "utf8" });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(packed.stderr || "npm pack failed");
  const archive = fs.readdirSync(temp).find((name) => name.endsWith(".tgz"));
  const extracted = spawnSync("tar", ["-xf", path.join(temp, archive), "-C", temp], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr || "tar extraction failed");
  const piWebRoot = path.join(temp, "package");
  const piWebPackage = JSON.parse(fs.readFileSync(path.join(piWebRoot, "package.json"), "utf8"));
  if (piWebPackage.dependencies?.[stack.upstream.agentRuntime.npm] !== stack.upstream.agentRuntime.version) {
    throw new Error(`Pi Web does not pin ${stack.upstream.agentRuntime.npm}@${stack.upstream.agentRuntime.version}`);
  }
  applyIntegration({ repoRoot, piWebRoot });
  const verification = verifyIntegration({ repoRoot, piWebRoot });
  if (!verification.ok) throw new Error(`integration verification failed: ${verification.reason}`);
  const route = path.join(piWebRoot, ".next", "server", "app", "api", "app-update", "route.js");
  const syntax = spawnSync(process.execPath, ["--check", route], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(syntax.stderr || "patched route syntax check failed");
  const removed = removeIntegration(piWebRoot);
  if (removed.action !== "removed") throw new Error(`integration removal failed: ${removed.reason}`);
  console.log(`Pi Web ${stack.upstream.gui.version} integration fixture passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
