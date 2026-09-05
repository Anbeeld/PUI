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
  const reasoningSummaryPatchRequired = VERSION_RE.test(release.version || "") && compareVersions(release.version, "1.2.0") >= 0;
  const reasoningSummaryPatch = release.stack.reasoningSummaryPatch;
  if (reasoningSummaryPatchRequired && (!reasoningSummaryPatch || reasoningSummaryPatch.schemaVersion !== 1)) errors.push("reasoningSummaryPatch.schemaVersion must be 1");
  if (reasoningSummaryPatchRequired && (!reasoningSummaryPatch || !Number.isInteger(reasoningSummaryPatch.revision) || reasoningSummaryPatch.revision < 1)) errors.push("reasoningSummaryPatch.revision must be a positive integer");
  if (reasoningSummaryPatchRequired && (!reasoningSummaryPatch || reasoningSummaryPatch.piWebPackage !== "@agegr/pi-web" || reasoningSummaryPatch.piWebVersion !== release.stack.upstream?.gui?.version)) errors.push("reasoningSummaryPatch must target the managed Pi Web package and version");
  if (reasoningSummaryPatchRequired && (!reasoningSummaryPatch || reasoningSummaryPatch.codingAgentPackage !== "@earendil-works/pi-coding-agent" || reasoningSummaryPatch.codingAgentVersion !== release.stack.upstream?.agentRuntime?.version)) errors.push("reasoningSummaryPatch must target the managed Pi runtime and version");
  if (reasoningSummaryPatchRequired && (!reasoningSummaryPatch || reasoningSummaryPatch.aiPackage !== "@earendil-works/pi-ai" || reasoningSummaryPatch.aiVersion !== release.stack.upstream?.agentRuntime?.version)) errors.push("reasoningSummaryPatch must target the managed Pi AI package and version");
  if (reasoningSummaryPatchRequired && (!reasoningSummaryPatch || reasoningSummaryPatch.backupSuffix !== ".pui-reasoning-original" || reasoningSummaryPatch.manifest !== ".pui-reasoning-summary.json")) errors.push("reasoningSummaryPatch ownership metadata is invalid");
  const skillLoaderRequired = VERSION_RE.test(release.version || "") && compareVersions(release.version, "1.3.0") >= 0;
  const skillLoader = release.stack.skillLoaderExtension;
  if (skillLoaderRequired && (!skillLoader || skillLoader.schemaVersion !== 1 ||
      skillLoader.target !== "~/.pi/agent/extensions/pui-skill-loader" || skillLoader.manifest !== "manifest.json" ||
      JSON.stringify(skillLoader.files) !== JSON.stringify(["core.ts", "index.ts", "package.json", "pui-extension-transaction.cjs"]))) {
    errors.push("skillLoaderExtension ownership metadata is invalid");
  }
  const reasoningSummaryExtension = release.stack.reasoningSummaryExtension;
  if (skillLoaderRequired && (!reasoningSummaryExtension || reasoningSummaryExtension.schemaVersion !== 1 ||
      reasoningSummaryExtension.target !== "~/.pi/agent/extensions/pui-reasoning-summary" || reasoningSummaryExtension.manifest !== "manifest.json" ||
      JSON.stringify(reasoningSummaryExtension.files) !== JSON.stringify(["core.ts", "index.ts", "package.json"]))) {
    errors.push("reasoningSummaryExtension.files and ownership metadata are invalid");
  }
  const reasoningSummaries = release.stack.reasoningSummaries;
  const reasoningModeEntries = reasoningSummaries?.modelModes && typeof reasoningSummaries.modelModes === "object" && !Array.isArray(reasoningSummaries.modelModes)
    ? Object.entries(reasoningSummaries.modelModes)
    : null;
  const validReasoningModes = new Set(["auto", "concise", "detailed", "none"]);
  const requiredDetailedModels = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
  if (skillLoaderRequired && (reasoningSummaries?.schemaVersion !== 1 || !reasoningModeEntries ||
      reasoningModeEntries.some(([model, mode]) => model === "" || model !== model.trim() || !validReasoningModes.has(mode)) ||
      requiredDetailedModels.some((model) => reasoningSummaries.modelModes[model] !== "detailed"))) {
    errors.push("reasoningSummaries.modelModes must use valid modes and default every GPT-5.6 variant to detailed");
  }
  if (skillLoaderRequired && release.stack.configPaths?.puiReasoningSummaries !== "~/.config/pui/reasoning-summaries.json") {
    errors.push("configPaths.puiReasoningSummaries must target ~/.config/pui/reasoning-summaries.json");
  }
  const sessionTitleExtension = release.stack.sessionTitleExtension;
  if (skillLoaderRequired && (!sessionTitleExtension || sessionTitleExtension.schemaVersion !== 1 ||
      sessionTitleExtension.target !== "~/.pi/agent/extensions/pui-session-title" || sessionTitleExtension.manifest !== "manifest.json" ||
      JSON.stringify(sessionTitleExtension.files) !== JSON.stringify(["core.ts", "index.ts", "package.json"]))) {
    errors.push("sessionTitleExtension ownership metadata is invalid");
  }
  const sessionTitleModels = release.stack.sessionTitles?.models;
  const normalizedTitleModels = Array.isArray(sessionTitleModels)
    ? sessionTitleModels.map((selector) => typeof selector === "string" ? selector.toLowerCase() : selector)
    : [];
  if (skillLoaderRequired && (release.stack.sessionTitles?.schemaVersion !== 1 || !Array.isArray(sessionTitleModels) ||
      sessionTitleModels.some((selector) => typeof selector !== "string" || selector === "" || selector !== selector.trim()) ||
      new Set(normalizedTitleModels).size !== normalizedTitleModels.length)) {
    errors.push("sessionTitles.models must contain non-empty, unpadded, case-insensitively unique strings");
  }
  if (skillLoaderRequired && release.stack.configPaths?.puiSessionTitles !== "~/.config/pui/session-titles.json") {
    errors.push("configPaths.puiSessionTitles must target ~/.config/pui/session-titles.json");
  }
  const backgroundPatchRequired = VERSION_RE.test(release.version || "") && compareVersions(release.version, "1.1.2") >= 0;
  const backgroundPatch = release.stack.backgroundTasksPromptPatch;
  if (backgroundPatchRequired && (!backgroundPatch || backgroundPatch.schemaVersion !== 1)) errors.push("backgroundTasksPromptPatch.schemaVersion must be 1");
  if (backgroundPatchRequired && (!backgroundPatch || !Number.isInteger(backgroundPatch.revision) || backgroundPatch.revision < 1)) errors.push("backgroundTasksPromptPatch.revision must be a positive integer");
  if (backgroundPatchRequired && (!backgroundPatch || backgroundPatch.packagePath !== "node_modules/@99percentpeople/pi-background-tasks")) errors.push("backgroundTasksPromptPatch.packagePath must target the managed package");
  if (backgroundPatchRequired && (!backgroundPatch || backgroundPatch.bundle !== "index.min.js")) errors.push("backgroundTasksPromptPatch.bundle must be index.min.js");
  if (backgroundPatchRequired && (!backgroundPatch || backgroundPatch.backupSuffix !== ".pui-original")) errors.push("backgroundTasksPromptPatch.backupSuffix must be .pui-original");
  if (backgroundPatchRequired && (!backgroundPatch || backgroundPatch.manifestSuffix !== ".pui-manifest.json")) errors.push("backgroundTasksPromptPatch.manifestSuffix must be .pui-manifest.json");
  const subagentsPatch = release.stack.subagentsPromptPatch;
  if (backgroundPatchRequired && (!subagentsPatch || subagentsPatch.schemaVersion !== 1)) errors.push("subagentsPromptPatch.schemaVersion must be 1");
  if (backgroundPatchRequired && (!subagentsPatch || !Number.isInteger(subagentsPatch.revision) || subagentsPatch.revision < 1)) errors.push("subagentsPromptPatch.revision must be a positive integer");
  if (backgroundPatchRequired && (!subagentsPatch || subagentsPatch.packagePath !== "node_modules/@gotgenes/pi-subagents")) errors.push("subagentsPromptPatch.packagePath must target the managed package");
  if (backgroundPatchRequired && (!subagentsPatch || !Array.isArray(subagentsPatch.files) || subagentsPatch.files.length === 0)) errors.push("subagentsPromptPatch.files must be a non-empty array");
  if (backgroundPatchRequired && subagentsPatch && Array.isArray(subagentsPatch.files)) {
    const files = subagentsPatch.files;
    const unsafe = files.some((file) => typeof file !== "string" || !file.startsWith("src/") || file.includes("\\") || path.posix.isAbsolute(file) || path.posix.normalize(file) !== file);
    if (unsafe || new Set(files).size !== files.length) errors.push("subagentsPromptPatch.files must be unique normalized source-relative paths");
  }
  const subagentsConfig = release.stack.subagents;
  if (backgroundPatchRequired && subagentsConfig?.schemaVersion !== 1) errors.push("subagents.schemaVersion must be 1");
  for (const field of ["maxConcurrent", "maxQueued"]) {
    if (backgroundPatchRequired && (!Number.isInteger(subagentsConfig?.[field]) || subagentsConfig[field] < 1)) {
      errors.push(`subagents.${field} must be a positive integer`);
    }
  }
  const mappingEntries = subagentsConfig?.modelMappings && typeof subagentsConfig.modelMappings === "object" && !Array.isArray(subagentsConfig.modelMappings)
    ? Object.entries(subagentsConfig.modelMappings)
    : null;
  const normalizedMappingKeys = mappingEntries ? mappingEntries.map(([parent]) => parent.toLowerCase()) : [];
  if (backgroundPatchRequired && (!mappingEntries || mappingEntries.some(([parent, child]) =>
      parent === "" || parent !== parent.trim() || typeof child !== "string" || child.trim() === "") ||
      new Set(normalizedMappingKeys).size !== normalizedMappingKeys.length)) {
    errors.push("subagents.modelMappings must contain non-empty, unpadded, case-insensitively unique string keys and non-empty string values");
  }
  if (backgroundPatchRequired && release.stack.configPaths?.puiSubagents !== "~/.config/pui/subagents.json") errors.push("configPaths.puiSubagents must target ~/.config/pui/subagents.json");
  if (backgroundPatchRequired && (!subagentsPatch || subagentsPatch.backupSuffix !== ".pui-original")) errors.push("subagentsPromptPatch.backupSuffix must be .pui-original");
  if (backgroundPatchRequired && (!subagentsPatch || subagentsPatch.manifest !== ".pui-subagents-prompt-manifest.json")) errors.push("subagentsPromptPatch.manifest must be .pui-subagents-prompt-manifest.json");
  if (backgroundPatchRequired && release.stack.mcp?.footerStatus !== "off") errors.push("mcp.footerStatus must be off");
  const mcpSpec = (release.stack.mcp?.args || []).find((arg) => typeof arg === "string" && arg.includes("@playwright/mcp"));
  const browser = release.stack.upstream?.browserAutomation;
  if (!browser || mcpSpec !== `${browser.npm}@${browser.version}`) errors.push("Playwright MCP must use its exact managed version");
  if (release.upgradeVia && !VERSION_RE.test(release.upgradeVia)) errors.push("upgradeVia must be an exact version");
  if (release.repoRoot) {
    const requiredFiles = [
      "install.ps1", "install.sh", "update.ps1", "update.sh", "doctor.ps1", "doctor.sh", "uninstall.ps1", "uninstall.sh",
      "lib/pui-updater.js", "lib/pui-update-extension.js", "lib/pui-web-integration.js", "lib/pui-update-bridge.cjs", "lib/pui-goal-patch.js", "lib/pui-native-check.js",
      "extensions/pui-update/index.ts", "assets/pui-update-client.js",
    ];
    if (skillLoaderRequired) requiredFiles.push("lib/pui-skill-loader-extension.js", "extensions/pui-skill-loader/core.ts", "extensions/pui-skill-loader/index.ts", "extensions/pui-skill-loader/package.json", "extensions/pui-skill-loader/pui-extension-transaction.cjs", "tests/pui-skill-loader-extension.test.js", "tests/pui-skill-loader-install.test.js", "lib/pui-reasoning-summary-extension.js", "extensions/pui-reasoning-summary/core.ts", "extensions/pui-reasoning-summary/index.ts", "extensions/pui-reasoning-summary/package.json", "tests/pui-reasoning-summary-extension.test.js", "tests/pui-reasoning-summary-extension-install.test.js", "lib/pui-session-title-extension.js", "extensions/pui-session-title/core.ts", "extensions/pui-session-title/index.ts", "extensions/pui-session-title/package.json", "tests/pui-session-title-extension.test.js", "tests/pui-session-title-install.test.js");
    if (reasoningSummaryPatchRequired) requiredFiles.push("lib/pui-reasoning-summary-patch.js", "tests/pui-reasoning-summary.test.js", "tests/verify-reasoning-summary.js");
    if (backgroundPatchRequired) requiredFiles.push("lib/pui-background-tasks-patch.js", "lib/pui-subagents-patch.js", "lib/pui-pi-8782-backport.js", "tests/verify-prompt-patches.js", "tests/verify-pi-8782-backport.js");
    for (const required of requiredFiles) if (!fs.existsSync(path.join(release.repoRoot, required))) errors.push(`missing required release file ${required}`);
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
