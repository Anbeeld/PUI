#!/usr/bin/env node
// PUI-managed, version-anchored model-selection policy for
// @gotgenes/pi-subagents. PUI patches model-facing metadata and runtime defaults
// so omitted model input follows exact parent-to-child mappings (or inherits the
// parent), while omitted thinking inherits the parent session's active level.
// Uninstall restores only the exact PUI-owned shape.

"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const stack = require("../stack.json");

const PACKAGE_NAME = "@gotgenes/pi-subagents";
const EXPECTED_VERSION = stack.upstream.subagents.version;
const PATCH_CONFIG = stack.subagentsPromptPatch;
const PATCH_FILES = [...PATCH_CONFIG.files];
const LEGACY_V1_FILES = [
  "src/tools/agent-tool.ts",
  "src/config/default-agents.ts",
  "src/config/invocation-config.ts",
];
const LEGACY_V1_SENTINEL = "// pui-subagents-patch:main-session-model-v1";
const SENTINEL = `// pui-subagents-patch:main-session-model-v${PATCH_CONFIG.revision}`;

const PROMPT_SNIPPET = "Launch a specialized agent using the user-configured fuzzy model mapping and the parent session's reasoning level unless the user explicitly overrides either.";
const DESCRIPTION_SENTENCE = "Launch a new agent to handle complex, multi-step tasks autonomously. By default, a subagent uses the user-configured fuzzy model mapping when one matches the parent, otherwise the parent model, and inherits the parent session's active reasoning level.";
const POLICY_GUIDELINE = "- Mandatory: Omit model unless the user explicitly requests a model override. PUI resolves an omitted model through the user's fuzzy model mappings when one matches the parent and otherwise inherits the parent model. Agent type, task, cost, speed, or your own judgment never authorize a model override.";
const THINKING_GUIDELINE = "- Omit thinking unless the user explicitly requests a different reasoning level; omission inherits the parent session's active reasoning level.";
const MODEL_PARAMETER_DESCRIPTION = 'Model override. Set only when the user explicitly requests a different model; otherwise omit it to use a matching user-configured fuzzy model mapping or inherit the parent model. Accepts "provider/modelId" or a fuzzy name (e.g. "haiku", "sonnet").';
const THINKING_PARAMETER_DESCRIPTION = "Reasoning-level override: off, minimal, low, medium, high, or xhigh. Set only when the user explicitly requests a different level; otherwise omit it to inherit the parent session's active reasoning level.";
const CONFIG_PATH = stack.configPaths.puiSubagents;
if (typeof CONFIG_PATH !== "string" || !CONFIG_PATH.startsWith("~/")) throw new Error("configPaths.puiSubagents must be a home-relative path");
const CONFIG_PATH_PARTS = CONFIG_PATH.slice(2).split("/");
const PUI_CONFIG_PATH_SOURCE = `const PUI_SUBAGENTS_CONFIG_PATH = join(homedir(), ${CONFIG_PATH_PARTS.map((part) => JSON.stringify(part)).join(", ")});`;

const ORIGINAL_SNIPPET = "Launch a specialized agent for complex, multi-step tasks.";
const ORIGINAL_DESCRIPTION_SENTENCE = "Launch a new agent to handle complex, multi-step tasks autonomously.";
const ORIGINAL_GUIDELINE = `'- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").'`;
const ORIGINAL_THINKING_GUIDELINE = "- Use thinking to control extended thinking level.";
const ORIGINAL_MODEL_PARAMETER_DESCRIPTION = 'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\\\'s default.';
const ORIGINAL_THINKING_PARAMETER_DESCRIPTION = "Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default.";
const ORIGINAL_EXPLORE_MODEL = '      model: "anthropic/claude-haiku-4-5-20251001",\n';
const ORIGINAL_MODEL_INPUT = "    modelInput: agentConfig?.model ?? params.model,";
const ORIGINAL_MODEL_FROM_PARAMS = "    modelFromParams: agentConfig?.model == null && params.model != null,";
const ORIGINAL_THINKING_INPUT = "    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,";
const ORIGINAL_DISPLAY_IMPORT = `import {
  type AgentDetails,
  buildInvocationTags,
  getDisplayName,
  getPromptModeLabel,
} from "#src/ui/display";`;
const ORIGINAL_MODEL_RESOLVER_IMPORT = `import type { ModelRegistry } from "#src/session/model-resolver";
import { resolveInvocationModel } from "#src/session/model-resolver";`;
const ORIGINAL_MODEL_INFO = `export interface ModelInfo {
  parentModel: Model<any> | undefined;
  modelRegistry: ModelRegistry | undefined;
}`;
const ORIGINAL_MODEL_RESOLUTION = `  // Resolve model
  const resolution = resolveInvocationModel(
    modelInfo.parentModel,
    resolvedConfig.modelInput,
    resolvedConfig.modelFromParams,
    modelInfo.modelRegistry,
  );`;
const ORIGINAL_RESOLVED_THINKING = "  const thinking = resolvedConfig.thinking;";
const ORIGINAL_RUNTIME_IMPORTS = `import { buildParentSnapshot, type ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { ModelInfo } from "#src/tools/spawn-config";
import type { SessionContext } from "#src/types";`;
const ORIGINAL_RUN_CONFIG_DOC = `/**
 * Narrow config subset read by Agent when driving the turn loop (defaultMaxTurns, graceTurns).
 * Kept separate so callers can satisfy it without depending on the full runtime.
 */`;
const ORIGINAL_RUNTIME_MODEL_INFO = `      parentModel: this.currentCtx?.model,
      modelRegistry: this.currentCtx?.modelRegistry,`;
const ORIGINAL_SESSION_MODEL_FIELDS = `  readonly model: Model<any> | undefined;
  readonly modelRegistry: ModelRegistry;`;
const PATCHED_MODEL_INFO = `export interface ModelInfo {
  parentModel: Model<any> | undefined;
  parentThinkingLevel: ThinkingLevel | undefined;
  modelRegistry: ModelRegistry | undefined;
  modelMappings: Readonly<Record<string, string>>;
  configError?: string;
}

function resolveConfiguredModelInput(modelInfo: ModelInfo): { modelInput?: string; error?: string } {
  if (modelInfo.configError) return { error: modelInfo.configError };
  if (!modelInfo.parentModel || !modelInfo.modelRegistry) return {};
  let modelInput: string | undefined;
  let matchedParent: string | undefined;
  for (const [parentInput, childInput] of Object.entries(modelInfo.modelMappings)) {
    const resolvedParent = resolveModel(parentInput, modelInfo.modelRegistry);
    if (typeof resolvedParent === "string") continue;
    if (resolvedParent.provider !== modelInfo.parentModel.provider || resolvedParent.id !== modelInfo.parentModel.id) continue;
    if (modelInput !== undefined) {
      return { error: \`Multiple configured mappings ("\${matchedParent}" and "\${parentInput}") resolve to the active parent model.\` };
    }
    matchedParent = parentInput;
    modelInput = childInput;
  }
  return { modelInput };
}`;
const PATCHED_RUNTIME_CONFIG = `import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
${ORIGINAL_RUNTIME_IMPORTS}

${PUI_CONFIG_PATH_SOURCE}

export function loadPuiModelMappings(configPath = PUI_SUBAGENTS_CONFIG_PATH): { modelMappings: Readonly<Record<string, string>>; error?: string } {
  if (!existsSync(configPath)) return { modelMappings: {}, error: \`PUI subagent model mapping config is missing: \${configPath}\` };
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { schemaVersion?: unknown; modelMappings?: unknown };
    const mappings = parsed.modelMappings;
    const validMappings = mappings !== null && typeof mappings === "object" && !Array.isArray(mappings) &&
      Object.entries(mappings).every(([parent, child]) => parent.trim() !== "" && typeof child === "string" && child.trim() !== "");
    if (parsed.schemaVersion !== 1 || !validMappings) {
      return { modelMappings: {}, error: \`PUI subagent model mapping config is invalid: \${configPath}\` };
    }
    return { modelMappings: mappings as Record<string, string> };
  } catch (error) {
    return { modelMappings: {}, error: \`PUI subagent model mapping config is invalid: \${configPath}: \${error instanceof Error ? error.message : String(error)}\` };
  }
}`;

const FILE_PLANS = {
  "src/tools/agent-tool.ts": {
    anchor: "export class AgentTool {",
    replacements: [
      [ORIGINAL_SNIPPET, PROMPT_SNIPPET],
      [`description: \`${ORIGINAL_DESCRIPTION_SENTENCE}\n\nThe subagent tool launches`, `description: \`${DESCRIPTION_SENTENCE}\n\nThe subagent tool launches`],
      [ORIGINAL_GUIDELINE, JSON.stringify(POLICY_GUIDELINE)],
      [ORIGINAL_THINKING_GUIDELINE, THINKING_GUIDELINE],
      [ORIGINAL_MODEL_PARAMETER_DESCRIPTION, MODEL_PARAMETER_DESCRIPTION],
      [ORIGINAL_THINKING_PARAMETER_DESCRIPTION, THINKING_PARAMETER_DESCRIPTION],
    ],
  },
  "src/config/default-agents.ts": {
    anchor: "export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([",
    replacements: [[ORIGINAL_EXPLORE_MODEL, ""]],
  },
  "src/config/invocation-config.ts": {
    anchor: "export function resolveAgentInvocationConfig(",
    replacements: [
      [ORIGINAL_MODEL_INPUT, "    modelInput: params.model,"],
      [ORIGINAL_MODEL_FROM_PARAMS, "    modelFromParams: params.model != null,"],
      [ORIGINAL_THINKING_INPUT, "    thinking: params.thinking as ThinkingLevel | undefined,"],
    ],
  },
  "src/tools/spawn-config.ts": {
    anchor: "export interface SpawnIdentity {",
    replacements: [
      [ORIGINAL_MODEL_RESOLVER_IMPORT, `import type { ModelRegistry } from "#src/session/model-resolver";\nimport { resolveInvocationModel, resolveModel } from "#src/session/model-resolver";`],
      [ORIGINAL_MODEL_INFO, PATCHED_MODEL_INFO],
      [ORIGINAL_MODEL_RESOLUTION, `  // Resolve an explicit override first, then a fuzzy user-configured mapping.\n  const configured = resolvedConfig.modelInput === undefined\n    ? resolveConfiguredModelInput(modelInfo)\n    : {};\n  if (configured.error) return { error: configured.error };\n  const resolution = resolveInvocationModel(\n    modelInfo.parentModel,\n    resolvedConfig.modelInput ?? configured.modelInput,\n    resolvedConfig.modelFromParams,\n    modelInfo.modelRegistry,\n  );`],
      [ORIGINAL_RESOLVED_THINKING, "  const thinking = resolvedConfig.thinking ?? modelInfo.parentThinkingLevel;"],
    ],
  },
  "src/runtime.ts": {
    anchor: "export class SubagentRuntime {",
    replacements: [
      [`${ORIGINAL_RUNTIME_IMPORTS}\n\n${ORIGINAL_RUN_CONFIG_DOC}`, `${PATCHED_RUNTIME_CONFIG}\n\n${ORIGINAL_RUN_CONFIG_DOC}`],
      [ORIGINAL_RUNTIME_MODEL_INFO, `      parentModel: this.currentCtx?.model,\n      parentThinkingLevel: this.currentCtx?.thinkingLevel,\n      modelRegistry: this.currentCtx?.modelRegistry,\n      ...loadPuiModelMappings(),`],
    ],
  },
  "src/types.ts": {
    anchor: "export interface SessionContext {",
    replacements: [
      [ORIGINAL_SESSION_MODEL_FIELDS, `  readonly model: Model<any> | undefined;\n  readonly thinkingLevel?: ThinkingLevel;\n  readonly modelRegistry: ModelRegistry;`],
    ],
  },
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function patchOne(relative, text) {
  const plan = FILE_PLANS[relative];
  if (!plan) return { ok: false, reason: "unexpected-file", file: relative };
  if (text.includes(SENTINEL)) {
    const sentinelCount = countOccurrences(text, SENTINEL);
    const mismatch = plan.replacements.find(([oldValue, newValue]) =>
      countOccurrences(text, oldValue) !== 0 || (newValue !== "" && countOccurrences(text, newValue) !== 1));
    const exact = sentinelCount === 1 && !mismatch;
    return exact
      ? { ok: true, patched: false, reason: "already-patched", text }
      : { ok: false, patched: false, reason: "patched-metadata-drift", file: relative, field: mismatch?.[0] ?? SENTINEL, expected: 1, actual: mismatch ? countOccurrences(text, mismatch[1]) : sentinelCount, text };
  }
  if (countOccurrences(text, plan.anchor) !== 1) return { ok: false, patched: false, reason: "anchor-drift", file: relative, text };
  let next = text;
  for (const [oldValue, newValue] of plan.replacements) {
    const actual = countOccurrences(next, oldValue);
    if (actual !== 1) return { ok: false, patched: false, reason: "metadata-drift", file: relative, field: oldValue, expected: 1, actual, text };
    next = next.replace(oldValue, newValue);
  }
  next = next.replace(plan.anchor, `${SENTINEL}\n${plan.anchor}`);
  const verified = patchOne(relative, next);
  if (!verified.ok) return { ok: false, patched: false, reason: "verification-failed", verificationReason: verified.reason, file: relative, field: verified.field, expected: verified.expected, actual: verified.actual, text };
  return { ok: true, patched: true, text: next };
}

function patchFiles(files) {
  if (!files || typeof files !== "object") return { patched: false, reason: "files-invalid" };
  const next = {};
  let changed = false;
  for (const relative of PATCH_FILES) {
    if (typeof files[relative] !== "string") return { patched: false, reason: "file-missing", file: relative };
    const result = patchOne(relative, files[relative]);
    if (!result.ok) return { patched: false, reason: result.reason, verificationReason: result.verificationReason, file: result.file, field: result.field, expected: result.expected, actual: result.actual };
    next[relative] = result.text;
    changed = changed || result.patched;
  }
  return { patched: changed, reason: changed ? "patched" : "already-patched", files: next };
}

function defaultPackageDir() {
  return path.join(os.homedir(), ".pi", "agent", "npm", ...PATCH_CONFIG.packagePath.split("/"));
}

function sourceFile(packageDir, relative) {
  return path.join(packageDir, ...relative.split("/"));
}

function backupFile(packageDir, relative) {
  return `${sourceFile(packageDir, relative)}${PATCH_CONFIG.backupSuffix}`;
}

function manifestFile(packageDir = defaultPackageDir()) {
  return path.join(packageDir, PATCH_CONFIG.manifest);
}

function artifactFiles(packageDir = defaultPackageDir()) {
  return [
    ...PATCH_FILES.map((relative) => sourceFile(packageDir, relative)),
    ...PATCH_FILES.map((relative) => backupFile(packageDir, relative)),
    manifestFile(packageDir),
  ];
}

function readFileSet(packageDir, backup = false) {
  const files = {};
  for (const relative of PATCH_FILES) {
    const file = backup ? backupFile(packageDir, relative) : sourceFile(packageDir, relative);
    if (!fs.existsSync(file)) return { ok: false, reason: backup ? "backup-missing" : "source-missing", file };
    files[relative] = fs.readFileSync(file, "utf8");
  }
  return { ok: true, files };
}

function manifestCore(manifest) {
  return {
    owner: manifest.owner,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    schemaVersion: manifest.schemaVersion,
    revision: manifest.revision,
    files: manifest.files,
  };
}

function createOwnershipManifest(originals, patched, packageVersion = EXPECTED_VERSION) {
  const manifest = {
    owner: "PUI",
    packageName: PACKAGE_NAME,
    packageVersion,
    schemaVersion: PATCH_CONFIG.schemaVersion,
    revision: PATCH_CONFIG.revision,
    files: PATCH_FILES.map((relative) => ({
      path: relative,
      originalHash: sha256(originals[relative]),
      patchedHash: sha256(patched[relative]),
    })),
  };
  manifest.identityHash = sha256(JSON.stringify(manifestCore(manifest)));
  return manifest;
}

function readOwnershipManifest(packageDir, allowStaleVersion = false) {
  const file = manifestFile(packageDir);
  if (!fs.existsSync(file)) return { ok: false, reason: "manifest-missing" };
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const keys = [...Object.keys(manifestCore(manifest)), "identityHash"].sort();
    if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(keys)) return { ok: false, reason: "invalid-manifest-shape" };
    if (manifest.owner !== "PUI" || manifest.packageName !== PACKAGE_NAME || (!allowStaleVersion && manifest.packageVersion !== EXPECTED_VERSION)) return { ok: false, reason: "invalid-manifest-identity" };
    if (!Number.isInteger(manifest.schemaVersion) || !Number.isInteger(manifest.revision) || manifest.identityHash !== sha256(JSON.stringify(manifestCore(manifest)))) return { ok: false, reason: "invalid-manifest-hash" };
    if (!Array.isArray(manifest.files) || manifest.files.length !== PATCH_FILES.length || manifest.files.some((entry, index) => entry.path !== PATCH_FILES[index] || typeof entry.originalHash !== "string" || typeof entry.patchedHash !== "string")) return { ok: false, reason: "invalid-manifest-files" };
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, reason: "invalid-manifest", error: error.message };
  }
}

function writeOwnershipManifest(packageDir, originals, patched) {
  fs.writeFileSync(manifestFile(packageDir), `${JSON.stringify(createOwnershipManifest(originals, patched), null, 2)}\n`, "utf8");
}

function readPackage(packageDir) {
  const file = path.join(packageDir, "package.json");
  if (!fs.existsSync(file)) return { ok: false, reason: "package-missing" };
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (manifest.name !== PACKAGE_NAME) return { ok: false, reason: "package-name-mismatch", actual: manifest.name };
    if (manifest.version !== EXPECTED_VERSION) return { ok: false, reason: "version-mismatch", expected: EXPECTED_VERSION, actual: manifest.version };
    return { ok: true, version: manifest.version };
  } catch (error) {
    return { ok: false, reason: "invalid-package", error: error.message };
  }
}

function expectedFromBackups(packageDir) {
  const originals = readFileSet(packageDir, true);
  if (!originals.ok) return originals;
  const transformed = patchFiles(originals.files);
  if (!transformed.patched) return { ok: false, reason: "backup-invalid", detail: transformed.reason, file: transformed.file };
  return { ok: true, originals: originals.files, patched: transformed.files };
}

function writePatchedSet(packageDir, files) {
  for (const relative of PATCH_FILES) fs.writeFileSync(sourceFile(packageDir, relative), files[relative], "utf8");
}

function migrateLegacyV1(packageDir, current, packageVersion) {
  const file = manifestFile(packageDir);
  if (!fs.existsSync(file)) return { applicable: false };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { applicable: false };
  }
  if (manifest?.revision !== 1) return { applicable: false };

  const keys = [...Object.keys(manifestCore(manifest)), "identityHash"].sort();
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(keys) ||
      manifest.owner !== "PUI" || manifest.packageName !== PACKAGE_NAME ||
      manifest.packageVersion !== packageVersion || manifest.schemaVersion !== 1 ||
      manifest.identityHash !== sha256(JSON.stringify(manifestCore(manifest))) ||
      !Array.isArray(manifest.files) || manifest.files.length !== LEGACY_V1_FILES.length ||
      manifest.files.some((entry, index) => entry.path !== LEGACY_V1_FILES[index] || typeof entry.originalHash !== "string" || typeof entry.patchedHash !== "string")) {
    return { applicable: true, ok: false, reason: "invalid-legacy-manifest" };
  }

  const originals = { ...current };
  for (const [index, relative] of LEGACY_V1_FILES.entries()) {
    const backup = backupFile(packageDir, relative);
    if (!fs.existsSync(backup)) return { applicable: true, ok: false, reason: "incomplete-legacy-owned-shape", file: relative };
    const original = fs.readFileSync(backup, "utf8");
    const currentHash = sha256(current[relative]);
    const currentIsPatched = currentHash === manifest.files[index].patchedHash;
    const currentIsOriginal = currentHash === manifest.files[index].originalHash;
    if (sha256(original) !== manifest.files[index].originalHash ||
        (!currentIsPatched && !currentIsOriginal) ||
        (currentIsPatched && countOccurrences(current[relative], LEGACY_V1_SENTINEL) !== 1)) {
      return { applicable: true, ok: false, reason: "legacy-owned-drift", file: relative };
    }
    originals[relative] = original;
  }
  for (const relative of PATCH_FILES.slice(LEGACY_V1_FILES.length)) {
    if (fs.existsSync(backupFile(packageDir, relative)) || current[relative].includes("// pui-subagents-patch:")) {
      return { applicable: true, ok: false, reason: "incomplete-legacy-owned-shape", file: relative };
    }
  }

  const transformed = patchFiles(originals);
  if (!transformed.patched) return { applicable: true, ok: false, reason: transformed.reason, file: transformed.file };
  for (const relative of PATCH_FILES) {
    const backup = backupFile(packageDir, relative);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, originals[relative], "utf8");
  }
  writePatchedSet(packageDir, transformed.files);
  writeOwnershipManifest(packageDir, originals, transformed.files);
  return { applicable: true, ok: true, action: "migrated" };
}

function apply(packageDir = defaultPackageDir()) {
  const packageResult = readPackage(packageDir);
  if (!packageResult.ok) return packageResult;
  const currentResult = readFileSet(packageDir);
  if (!currentResult.ok) return currentResult;
  let current = currentResult.files;
  const backupStates = PATCH_FILES.map((relative) => fs.existsSync(backupFile(packageDir, relative)));
  const backupCount = backupStates.filter(Boolean).length;
  const hasManifest = fs.existsSync(manifestFile(packageDir));
  const legacyMigration = migrateLegacyV1(packageDir, current, packageResult.version);
  if (legacyMigration.applicable) {
    const { applicable, ...result } = legacyMigration;
    return result;
  }

  if (backupCount === 0 && !hasManifest) {
    const transformed = patchFiles(current);
    if (!transformed.patched) return { ok: false, reason: transformed.reason, file: transformed.file };
    for (const relative of PATCH_FILES) {
      const backup = backupFile(packageDir, relative);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(sourceFile(packageDir, relative), backup);
    }
    writePatchedSet(packageDir, transformed.files);
    writeOwnershipManifest(packageDir, current, transformed.files);
    return { ok: true, action: "patched" };
  }
  if (backupCount !== PATCH_FILES.length) return { ok: false, reason: "incomplete-owned-shape" };

  if (hasManifest && PATCH_FILES.every((relative) => !current[relative].includes(SENTINEL))) {
    const stale = readOwnershipManifest(packageDir, true);
    if (stale.ok && stale.manifest.packageVersion !== packageResult.version) {
      const transformed = patchFiles(current);
      if (!transformed.patched) return { ok: false, reason: transformed.reason, file: transformed.file };
      for (const relative of PATCH_FILES) fs.writeFileSync(backupFile(packageDir, relative), current[relative], "utf8");
      writePatchedSet(packageDir, transformed.files);
      writeOwnershipManifest(packageDir, current, transformed.files);
      return { ok: true, action: "rebased" };
    }
  }

  const expected = expectedFromBackups(packageDir);
  if (!expected.ok) return expected;
  if (!hasManifest) {
    for (const relative of PATCH_FILES) {
      if (current[relative] !== expected.originals[relative] && current[relative] !== expected.patched[relative]) return { ok: false, reason: "incomplete-owned-shape", file: relative };
    }
    const alreadyDesired = PATCH_FILES.every((relative) => current[relative] === expected.patched[relative]);
    writePatchedSet(packageDir, expected.patched);
    writeOwnershipManifest(packageDir, expected.originals, expected.patched);
    return { ok: true, action: alreadyDesired ? "adopted" : "patched" };
  }

  const ownership = readOwnershipManifest(packageDir);
  if (!ownership.ok) return ownership;
  let allDesired = true;
  let allOwned = true;
  for (const [index, relative] of PATCH_FILES.entries()) {
    const record = ownership.manifest.files[index];
    if (sha256(expected.originals[relative]) !== record.originalHash) return { ok: false, reason: "backup-hash-mismatch", file: relative };
    const currentHash = sha256(current[relative]);
    const desiredHash = sha256(expected.patched[relative]);
    if (currentHash !== record.patchedHash && currentHash !== record.originalHash && currentHash !== desiredHash) return { ok: false, reason: "installed-drift", file: relative };
    allDesired = allDesired && current[relative] === expected.patched[relative];
    allOwned = allOwned && currentHash === record.patchedHash;
  }
  writePatchedSet(packageDir, expected.patched);
  writeOwnershipManifest(packageDir, expected.originals, expected.patched);
  return { ok: true, action: allDesired ? (allOwned ? "already-patched" : "adopted") : "updated" };
}

function verify(packageDir = defaultPackageDir()) {
  const packageResult = readPackage(packageDir);
  if (!packageResult.ok) return packageResult;
  const current = readFileSet(packageDir);
  if (!current.ok) return current;
  const expected = expectedFromBackups(packageDir);
  if (!expected.ok) return expected;
  const ownership = readOwnershipManifest(packageDir);
  if (!ownership.ok) return ownership;
  for (const [index, relative] of PATCH_FILES.entries()) {
    const record = ownership.manifest.files[index];
    if (sha256(expected.originals[relative]) !== record.originalHash || sha256(current.files[relative]) !== record.patchedHash || current.files[relative] !== expected.patched[relative]) return { ok: false, reason: "installed-drift", file: relative };
  }
  return { ok: true };
}

function remove(packageDir = defaultPackageDir()) {
  const existingSources = PATCH_FILES.filter((relative) => fs.existsSync(sourceFile(packageDir, relative)));
  const existingBackups = PATCH_FILES.filter((relative) => fs.existsSync(backupFile(packageDir, relative)));
  const hasManifest = fs.existsSync(manifestFile(packageDir));
  if (existingSources.length === 0 && existingBackups.length === 0 && !hasManifest) return { ok: true, action: "absent" };
  if (existingSources.length === PATCH_FILES.length && existingBackups.length === 0 && !hasManifest && existingSources.every((relative) => !fs.readFileSync(sourceFile(packageDir, relative), "utf8").includes(SENTINEL))) return { ok: true, action: "absent" };
  if (existingSources.length !== PATCH_FILES.length || existingBackups.length !== PATCH_FILES.length || !hasManifest) return { ok: false, action: "preserved", reason: "incomplete-owned-shape" };
  const ownership = readOwnershipManifest(packageDir, true);
  if (!ownership.ok) return { ok: false, action: "preserved", reason: ownership.reason };
  for (const [index, relative] of PATCH_FILES.entries()) {
    const original = fs.readFileSync(backupFile(packageDir, relative), "utf8");
    const current = fs.readFileSync(sourceFile(packageDir, relative), "utf8");
    const record = ownership.manifest.files[index];
    if (sha256(original) !== record.originalHash) return { ok: false, action: "preserved", reason: "backup-hash-mismatch", file: relative };
    if (sha256(current) !== record.patchedHash && current !== original) return { ok: false, action: "preserved", reason: "modified", file: relative };
  }
  for (const relative of PATCH_FILES) {
    fs.copyFileSync(backupFile(packageDir, relative), sourceFile(packageDir, relative));
    fs.unlinkSync(backupFile(packageDir, relative));
  }
  fs.unlinkSync(manifestFile(packageDir));
  return { ok: true, action: "restored" };
}

function snapshotCore(state) {
  return { owner: state.owner, schemaVersion: state.schemaVersion, packageDir: state.packageDir, artifacts: state.artifacts };
}

function snapshot(stateDir, packageDir = defaultPackageDir()) {
  const stateFile = path.join(stateDir, "state.json");
  if (fs.existsSync(stateFile)) return { ok: false, reason: "snapshot-exists", stateDir };
  fs.mkdirSync(stateDir, { recursive: true });
  const artifacts = artifactFiles(packageDir).map((file, index) => {
    const existed = fs.existsSync(file);
    const copy = `${index}.artifact`;
    const hash = existed ? sha256(fs.readFileSync(file)) : null;
    if (existed) fs.copyFileSync(file, path.join(stateDir, copy));
    return { existed, copy, hash };
  });
  const state = { owner: "PUI", schemaVersion: 1, packageDir: path.resolve(packageDir), artifacts };
  state.identityHash = sha256(JSON.stringify(snapshotCore(state)));
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { ok: true, stateDir };
}

function restoreSnapshot(stateDir, packageDir = defaultPackageDir()) {
  const stateFile = path.join(stateDir, "state.json");
  if (!fs.existsSync(stateFile)) return { ok: false, reason: "snapshot-missing", stateDir };
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (error) { return { ok: false, reason: "snapshot-invalid", error: error.message }; }
  const files = artifactFiles(packageDir);
  if (state.owner !== "PUI" || state.schemaVersion !== 1 || state.packageDir !== path.resolve(packageDir) || !Array.isArray(state.artifacts) || state.artifacts.length !== files.length || state.identityHash !== sha256(JSON.stringify(snapshotCore(state)))) return { ok: false, reason: "snapshot-invalid" };
  for (const [index, artifact] of state.artifacts.entries()) {
    const copy = path.join(stateDir, `${index}.artifact`);
    if (artifact.copy !== `${index}.artifact` || typeof artifact.existed !== "boolean") return { ok: false, reason: "snapshot-invalid" };
    if (artifact.existed && (!fs.existsSync(copy) || sha256(fs.readFileSync(copy)) !== artifact.hash)) return { ok: false, reason: "snapshot-drift" };
    if (!artifact.existed && (artifact.hash !== null || fs.existsSync(copy))) return { ok: false, reason: "snapshot-invalid" };
  }
  for (const [index, artifact] of state.artifacts.entries()) {
    const file = files[index];
    if (artifact.existed) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(stateDir, artifact.copy), file);
    } else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  return { ok: true, stateDir };
}

const UPDATE_STATUS_FILE = path.join(os.tmpdir(), "pui-update-status.json");
const UPDATE_LOCK_FILE = path.join(os.tmpdir(), "pui-update.lock");
const UPDATE_GUARD_FILE = path.join(os.tmpdir(), "pui-subagents-guard.json");

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function processIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === "EPERM"; }
}

function removeGuardOwner(ownerFile, transactionId, stateDir) {
  if (!ownerFile || !fs.existsSync(ownerFile)) return;
  const owner = readStatus(ownerFile);
  if (owner && owner.id === transactionId && owner.stateDir === path.resolve(stateDir)) fs.unlinkSync(ownerFile);
}

function resolveGuardSnapshot(stateDir, packageDir, restore, options = {}) {
  if (restore) {
    const restored = restoreSnapshot(stateDir, packageDir);
    if (!restored.ok) return { ok: false, reason: `guard-${restored.reason}`, stateDir };
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  removeGuardOwner(options.ownerFile, options.transactionId, stateDir);
  return { ok: true, action: restore ? "restored" : "committed" };
}

function guardSnapshot(stateDir, target, options = {}) {
  const packageDir = options.packageDir || defaultPackageDir();
  const statusFile = options.statusFile || UPDATE_STATUS_FILE;
  const lockFile = options.lockFile || UPDATE_LOCK_FILE;
  const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;
  const intervalMs = options.intervalMs ?? 250;
  const initial = readStatus(statusFile);
  if (!initial || typeof initial.id !== "string" || initial.target !== target || (options.transactionId && initial.id !== options.transactionId)) {
    return { ok: false, reason: "guard-status-mismatch" };
  }
  const resolve = (restore) => resolveGuardSnapshot(stateDir, packageDir, restore, {
    ownerFile: options.ownerFile,
    transactionId: initial.id,
  });
  fs.writeFileSync(path.join(stateDir, "guard-ready"), `${initial.id}\n`, "utf8");
  const deadline = Date.now() + timeoutMs;
  const graceMs = options.graceMs ?? 3000;
  let anomalySince = null;
  while (true) {
    const status = readStatus(statusFile);
    if (status && status.id === initial.id && status.result) return resolve(status.result !== "success");
    const lock = readStatus(lockFile);
    const locked = lock && lock.id === initial.id && Number.isInteger(lock.pid) && processIsRunning(lock.pid);
    if (locked) {
      anomalySince = null;
    } else {
      // A result write and lock release can race a poll; only treat a sustained
      // absence as worker death. The status check above keeps running through
      // the grace period, so an observed terminal result always wins.
      if (anomalySince === null) anomalySince = Date.now();
      else if (Date.now() - anomalySince > graceMs) return resolve(true);
    }
    if (Date.now() > deadline) return resolve(true);
    sleepMs(intervalMs);
  }
}

function activeTransaction(scriptVersion, options = {}) {
  const lockFile = options.lockFile || UPDATE_LOCK_FILE;
  const statusFile = options.statusFile || UPDATE_STATUS_FILE;
  const lock = readStatus(lockFile);
  const status = readStatus(statusFile);
  if (!lock || !status || !Number.isInteger(lock.pid) || typeof lock.id !== "string" || lock.id !== status.id || !processIsRunning(lock.pid)) return null;
  if (status.result != null || typeof status.target !== "string") return null;
  const runsThisScript = typeof status.step === "string" ? status.step === scriptVersion : status.target === scriptVersion;
  return runsThisScript ? { id: status.id, target: status.target } : null;
}

function spawnGuard(stateDir, scriptVersion) {
  const transaction = activeTransaction(scriptVersion);
  if (!transaction) return { ok: true, action: "not-needed" };
  const existing = readStatus(UPDATE_GUARD_FILE);
  if (existing && existing.id === transaction.id && Number.isInteger(existing.pid) && processIsRunning(existing.pid)) {
    return { ok: true, action: "already-guarded", pid: existing.pid, target: transaction.target };
  }
  if (fs.existsSync(UPDATE_GUARD_FILE)) fs.unlinkSync(UPDATE_GUARD_FILE);
  const child = spawn(process.execPath, [__filename, "guard-snapshot", stateDir, transaction.target, UPDATE_GUARD_FILE, transaction.id], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
  if (!Number.isInteger(child.pid)) return { ok: false, reason: "guard-spawn-failed" };
  fs.writeFileSync(UPDATE_GUARD_FILE, `${JSON.stringify({ id: transaction.id, pid: child.pid, stateDir: path.resolve(stateDir) })}\n`, "utf8");
  return { ok: true, action: "guard-started", pid: child.pid, target: transaction.target };
}

function main(argv) {
  const command = argv[0] || "apply";
  const dirIndex = argv.indexOf("--dir");
  const packageDir = dirIndex >= 0 ? argv[dirIndex + 1] : defaultPackageDir();
  let result;
  if (command === "apply") result = apply(packageDir);
  else if (command === "verify") result = verify(packageDir);
  else if (command === "remove") result = remove(packageDir);
  else if (command === "snapshot") result = snapshot(argv[1], packageDir);
  else if (command === "restore-snapshot") result = restoreSnapshot(argv[1], packageDir);
  else if (command === "guard-snapshot") result = guardSnapshot(argv[1], argv[2], { packageDir, ownerFile: argv[3], transactionId: argv[4] });
  else if (command === "spawn-guard") result = spawnGuard(argv[1], argv[2]);
  else {
    console.error("Usage: pui-subagents-patch.js [apply|verify|remove] [--dir <package-dir>] | <snapshot|restore-snapshot> <state-dir> [--dir <package-dir>] | <spawn-guard|guard-snapshot> <state-dir> <target-version>");
    return 64;
  }
  const output = JSON.stringify(result);
  if (result.ok) console.log(output); else console.error(output);
  if (command === "spawn-guard" && result.action === "not-needed") return 75;
  if (command === "spawn-guard" && result.action === "already-guarded") return 76;
  if (result.ok) return 0;
  return command === "remove" && result.action === "preserved" ? 2 : 1;
}

module.exports = {
  DESCRIPTION_SENTENCE,
  EXPECTED_VERSION,
  MODEL_PARAMETER_DESCRIPTION,
  PATCH_FILES,
  POLICY_GUIDELINE,
  PROMPT_SNIPPET,
  SENTINEL,
  THINKING_PARAMETER_DESCRIPTION,
  activeTransaction,
  guardSnapshot,
  spawnGuard,
  apply,
  artifactFiles,
  backupFile,
  createOwnershipManifest,
  defaultPackageDir,
  manifestFile,
  patchFiles,
  remove,
  restoreSnapshot,
  snapshot,
  verify,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
