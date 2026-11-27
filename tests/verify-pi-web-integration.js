#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { applyIntegration, removeIntegration, verifyIntegration } = require("../lib/pui-web-integration.js");
const sessionCommunicationPatch = require("../lib/pui-session-communication-patch.js");

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
  // Git's Windows tar treats a drive-letter path as a remote archive. Use
  // the temporary directory as cwd and pass only the archive name.
  const extracted = spawnSync("tar", ["-xf", archive, "-C", "."], { cwd: temp, encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr || "tar extraction failed");
  const piWebRoot = path.join(temp, "package");
  const piWebPackage = JSON.parse(fs.readFileSync(path.join(piWebRoot, "package.json"), "utf8"));
  if (piWebPackage.dependencies?.[stack.upstream.agentRuntime.npm] !== stack.upstream.agentRuntime.version) {
    throw new Error(`Pi Web does not pin ${stack.upstream.agentRuntime.npm}@${stack.upstream.agentRuntime.version}`);
  }
  const sessionPatch = sessionCommunicationPatch.apply(repoRoot, piWebRoot);
  if (!sessionPatch.ok) throw new Error(`session communication patch failed: ${sessionPatch.reason}`);
  const sessionVerification = sessionCommunicationPatch.verify(repoRoot, piWebRoot);
  if (!sessionVerification.ok) throw new Error(`session communication verification failed: ${sessionVerification.reason}`);
  applyIntegration({ repoRoot, piWebRoot });
  const verification = verifyIntegration({ repoRoot, piWebRoot });
  if (!verification.ok) throw new Error(`integration verification failed: ${verification.reason}`);
  const route = path.join(piWebRoot, ".next", "server", "app", "api", "app-update", "route.js");
  const syntax = spawnSync(process.execPath, ["--check", route], { encoding: "utf8" });
  if (syntax.status !== 0) throw new Error(syntax.stderr || "patched route syntax check failed");
  const sessionChunk = path.join(piWebRoot, ".next", "server", "chunks", "6429.js");
  const sessionSyntax = spawnSync(process.execPath, ["--check", sessionChunk], { encoding: "utf8" });
  if (sessionSyntax.status !== 0) throw new Error(sessionSyntax.stderr || "patched session chunk syntax check failed");
  // Run the exact npm launcher with isolated provider/Next fixtures. This proves
  // refresh ordering without credentials, live network calls, or stopping PUI.
  const launcher = path.join(piWebRoot, "bin", "pi-web.js");
  const launcherSyntax = spawnSync(process.execPath, ["--check", launcher], { encoding: "utf8" });
  if (launcherSyntax.status !== 0) throw new Error(launcherSyntax.stderr || "patched launcher syntax check failed");
  const agentDir = path.join(temp, "agent");
  fs.mkdirSync(agentDir);
  const catalog = path.join(agentDir, "models-store.json");
  const marker = path.join(agentDir, "server-observation.json");
  const runtime = path.join(piWebRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const next = path.join(piWebRoot, "node_modules", "next", "dist", "bin", "next");
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.dirname(next), { recursive: true });
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ name: stack.upstream.agentRuntime.npm, bin: { pi: "cli.cjs" } }));
  const successfulRefresh = `const fs=require('node:fs'),path=require('node:path');
    if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['update','--models','--no-approve']))process.exit(7);
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'models-store.json'),'{"fresh":true}');`;
  fs.writeFileSync(path.join(runtime, "cli.cjs"), successfulRefresh);
  fs.writeFileSync(next, `const fs=require('node:fs'),path=require('node:path');
    const root=process.env.PI_CODING_AGENT_DIR;
    fs.copyFileSync(path.join(root,'models-store.json'),path.join(root,'server-observation.json'));`);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "0" };
  function launch(args = ["--no-open"], launchEnv = env) {
    const run = spawnSync(process.execPath, [launcher, ...args], { env: launchEnv, encoding: "utf8", timeout: 10000 });
    if (run.error || run.status !== 0) throw new Error("Isolated Pi Web startup failed");
    return run;
  }
  for (let run = 0; run < 2; run += 1) {
    fs.writeFileSync(catalog, '{"cached":true}');
    launch();
    assert.deepEqual(JSON.parse(fs.readFileSync(marker)), { fresh: true });
  }
  fs.writeFileSync(path.join(runtime, "cli.cjs"), "process.exit(3)");
  fs.writeFileSync(catalog, '{"cached":true}');
  assert.match(launch().stderr, /starting with cached models/);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), { cached: true });
  fs.unlinkSync(marker);
  launch(["--help"]);
  assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(path.join(runtime, "cli.cjs"), successfulRefresh);
  launch(["--no-open"], { ...env, PI_OFFLINE: "1" });
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), { cached: true });
  const removed = removeIntegration(piWebRoot);
  if (removed.action !== "removed") throw new Error(`integration removal failed: ${removed.reason}`);
  const sessionRemoved = sessionCommunicationPatch.remove(piWebRoot);
  if (sessionRemoved.action !== "restored") throw new Error(`session communication removal failed: ${sessionRemoved.reason}`);
  console.log(`Pi Web ${stack.upstream.gui.version} integration, startup model refresh, and session-activity fixture passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
