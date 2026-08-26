#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const VERSION_RE = /^\d+\.\d+\.\d+$/;

function parseVersion(version) {
  if (!VERSION_RE.test(version)) throw new Error(`Invalid semantic version: ${version}`);
  return version.split(".").map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function managedComposition(stack) {
  const managed = {};
  for (const [name, component] of Object.entries(stack.upstream || {})) {
    if (typeof component.npm === "string") managed[name] = `${component.npm}@${component.version}`;
  }
  return managed;
}

function loadRelease(repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const stack = JSON.parse(fs.readFileSync(path.join(repoRoot, "stack.json"), "utf8"));
  return {
    repoRoot,
    version: packageJson.version,
    upgradeVia: stack.upgradeVia || null,
    stack,
    managed: managedComposition(stack),
  };
}

function validateRelease(release) {
  const errors = [];
  if (!VERSION_RE.test(release.version || "")) errors.push("package.json version must be an exact version");
  for (const [name, component] of Object.entries(release.stack.upstream || {})) {
    if (!VERSION_RE.test(component.version || "")) errors.push(`${name} must have an exact version`);
  }
  for (const spec of release.stack.piPackages || []) {
    if (!/^npm:(?:@[^/]+\/)?[^@]+@\d+\.\d+\.\d+$/.test(spec)) errors.push(`managed Pi package is not exact: ${spec}`);
    const npmName = spec.replace(/^npm:/, "").replace(/@\d+\.\d+\.\d+$/, "");
    const component = Object.values(release.stack.upstream || {}).find((entry) => entry.npm === npmName);
    if (!component || spec !== `npm:${component.npm}@${component.version}`) errors.push(`piPackages entry must match its exact upstream version: ${spec}`);
  }
  const mcpSpec = (release.stack.mcp?.args || []).find((arg) => typeof arg === "string" && arg.includes("@playwright/mcp"));
  const browser = release.stack.upstream?.browserAutomation;
  if (!browser || mcpSpec !== `${browser.npm}@${browser.version}`) errors.push("Playwright MCP must use its exact managed version");
  if (release.upgradeVia && !VERSION_RE.test(release.upgradeVia)) errors.push("upgradeVia must be an exact version");
  if (release.repoRoot) {
    for (const required of [
      "install.ps1", "install.sh", "update.ps1", "update.sh", "doctor.ps1", "doctor.sh", "uninstall.ps1", "uninstall.sh",
      "lib/pui-updater.js", "lib/pui-update-extension.js", "lib/pui-web-integration.js", "lib/pui-update-bridge.cjs",
      "extensions/pui-update/index.ts", "assets/pui-update-client.js",
    ]) if (!fs.existsSync(path.join(release.repoRoot, required))) errors.push(`missing required release file ${required}`);
  }
  return errors;
}

async function resolveUpgradeRoute(installed, target, loadManifest) {
  if (compareVersions(installed, target) >= 0) throw new Error("Target must be newer than installed version");
  const backwards = [];
  const seen = new Set();
  let cursor = target;
  while (true) {
    if (seen.has(cursor)) throw new Error(`Upgrade checkpoint cycle at ${cursor}`);
    seen.add(cursor);
    const manifest = await loadManifest(cursor);
    if (!manifest) throw new Error(`Missing release manifest for ${cursor}`);
    if (manifest.version && manifest.version !== cursor) throw new Error(`Release manifest version mismatch for ${cursor}`);
    backwards.push(cursor);
    if (!manifest.upgradeVia) break;
    const checkpoint = manifest.upgradeVia;
    if (seen.has(checkpoint)) throw new Error(`Upgrade checkpoint cycle at ${checkpoint}`);
    if (compareVersions(checkpoint, installed) <= 0) break;
    if (compareVersions(checkpoint, cursor) >= 0) {
      throw new Error(`Non-monotonic upgrade checkpoint ${checkpoint} for ${cursor}`);
    }
    cursor = checkpoint;
  }
  return backwards.reverse();
}

function main(argv) {
  const [command, repoRoot = process.cwd()] = argv;
  if (command !== "validate") {
    console.error("Usage: pui-release.js validate [repo-root]");
    return 64;
  }
  try {
    const errors = validateRelease(loadRelease(repoRoot));
    if (errors.length) {
      for (const error of errors) console.error(`ERROR: ${error}`);
      return 1;
    }
    console.log("PUI release manifest valid");
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
  }
}

module.exports = { compareVersions, loadRelease, managedComposition, parseVersion, resolveUpgradeRoute, validateRelease };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
