const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const patchModule = () => require("../lib/pui-subagents-patch.js");

const AGENT_TOOL = `import { defineTool } from "@earendil-works/pi-coding-agent";

export class AgentTool {
\ttoToolDefinition() {
\t\tconst guidelines = [
\t\t\t"- For parallel work, use run_in_background: true on each agent. Foreground calls run sequentially — only one executes at a time.",
\t\t\t'- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").',
\t\t\t"- Use thinking to control extended thinking level.",
\t\t].join("\\n");
\t\treturn defineTool({
\t\t\tpromptSnippet: "Launch a specialized agent for complex, multi-step tasks.",
\t\t\tdescription: \`Launch a new agent to handle complex, multi-step tasks autonomously.

The subagent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.
\`,
\t\t\tparameters: Type.Object({
\t\t\t\tmodel: Type.Optional(
\t\t\t\t\tType.String({
\t\t\t\t\t\tdescription:
\t\t\t\t\t\t\t'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\\'s default.',
\t\t\t\t\t}),
\t\t\t\t),
\t\t\t\tthinking: Type.Optional(
\t\t\t\t\tType.String({
\t\t\t\t\t\tdescription:
\t\t\t\t\t\t\t"Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default.",
\t\t\t\t\t}),
\t\t\t\t),
\t\t\t}),
\t\t});
\t}
}
`;

const DEFAULT_AGENTS = `import type { AgentConfig } from "#src/types";

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "Explore",
    {
      name: "Explore",
      displayName: "Explore",
      description: "Fast codebase exploration agent (read-only)",
      toolNames: READ_ONLY_TOOLS,
      model: "anthropic/claude-haiku-4-5-20251001",
      systemPrompt: "read only",
    },
  ],
]);
`;

const INVOCATION_CONFIG = `import type { AgentConfig } from "#src/types";

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
) {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
  };
}
`;

const SPAWN_CONFIG = `import type { ModelRegistry } from "#src/session/model-resolver";
import { resolveInvocationModel } from "#src/session/model-resolver";
import {
  type AgentDetails,
  buildInvocationTags,
  getDisplayName,
  getPromptModeLabel,
} from "#src/ui/display";

/** Model info extracted from the parent session context. */
export interface ModelInfo {
  parentModel: Model<any> | undefined;
  modelRegistry: ModelRegistry | undefined;
}

export interface SpawnIdentity {
  subagentType: string;
}

export function resolveSpawnConfig(params, registry, modelInfo, settings) {
  const customConfig = registry.resolveAgentConfig("general-purpose");
  const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

  // Resolve model
  const resolution = resolveInvocationModel(
    modelInfo.parentModel,
    resolvedConfig.modelInput,
    resolvedConfig.modelFromParams,
    modelInfo.modelRegistry,
  );
  if (resolution.error) return { error: resolution.error };
  const model = resolution.model;

  const thinking = resolvedConfig.thinking;
  return { execution: { model, thinking } };
}
`;

const RUNTIME = `import { buildParentSnapshot, type ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { ModelInfo } from "#src/tools/spawn-config";
import type { SessionContext } from "#src/types";

/**
 * Narrow config subset read by Agent when driving the turn loop (defaultMaxTurns, graceTurns).
 * Kept separate so callers can satisfy it without depending on the full runtime.
 */
export interface RunConfig {
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
}

export class SubagentRuntime {
  getModelInfo(): ModelInfo {
    return {
      parentModel: this.currentCtx?.model,
      modelRegistry: this.currentCtx?.modelRegistry,
    };
  }
}
`;

const TYPES = `export interface SessionContext {
  readonly cwd: string;
  readonly model: Model<any> | undefined;
  readonly modelRegistry: ModelRegistry;
  getSystemPrompt(): string;
}
`;

function fixtureFiles() {
  return {
    "src/tools/agent-tool.ts": AGENT_TOOL,
    "src/config/default-agents.ts": DEFAULT_AGENTS,
    "src/config/invocation-config.ts": INVOCATION_CONFIG,
    "src/tools/spawn-config.ts": SPAWN_CONFIG,
    "src/runtime.ts": RUNTIME,
    "src/types.ts": TYPES,
  };
}

function makePackage(version = "19.3.5") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-subagents-patch-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@gotgenes/pi-subagents", version, type: "module" }));
  for (const [relative, content] of Object.entries(fixtureFiles())) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  return dir;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function installLegacyV1Shape(dir) {
  const legacyFiles = [
    "src/tools/agent-tool.ts",
    "src/config/default-agents.ts",
    "src/config/invocation-config.ts",
  ];
  const originals = fixtureFiles();
  const patched = {
    ...originals,
    "src/tools/agent-tool.ts": originals["src/tools/agent-tool.ts"]
      .replace("export class AgentTool {", "// pui-subagents-patch:main-session-model-v1\nexport class AgentTool {")
      .replace("Launch a specialized agent for complex, multi-step tasks.", "Launch a specialized agent using the main session model unless the user explicitly requests another model."),
    "src/config/default-agents.ts": originals["src/config/default-agents.ts"]
      .replace("export const DEFAULT_AGENTS", "// pui-subagents-patch:main-session-model-v1\nexport const DEFAULT_AGENTS")
      .replace('      model: "anthropic/claude-haiku-4-5-20251001",\n', ""),
    "src/config/invocation-config.ts": originals["src/config/invocation-config.ts"]
      .replace("export function resolveAgentInvocationConfig(", "// pui-subagents-patch:main-session-model-v1\nexport function resolveAgentInvocationConfig(")
      .replace("modelInput: agentConfig?.model ?? params.model", "modelInput: params.model")
      .replace("modelFromParams: agentConfig?.model == null && params.model != null", "modelFromParams: params.model != null"),
  };
  const manifest = {
    owner: "PUI",
    packageName: "@gotgenes/pi-subagents",
    packageVersion: "19.3.5",
    schemaVersion: 1,
    revision: 1,
    files: legacyFiles.map((relative) => ({
      path: relative,
      originalHash: sha256(originals[relative]),
      patchedHash: sha256(patched[relative]),
    })),
  };
  manifest.identityHash = sha256(JSON.stringify(manifest));
  for (const relative of legacyFiles) {
    fs.writeFileSync(path.join(dir, relative), patched[relative]);
    fs.writeFileSync(`${path.join(dir, relative)}.pui-original`, originals[relative]);
  }
  fs.writeFileSync(path.join(dir, ".pui-subagents-prompt-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function installBrokenRevision3Shape(dir) {
  const { patchFiles, PATCH_FILES, POLICY_GUIDELINE, SENTINEL } = patchModule();
  const originals = fixtureFiles();
  const result = patchFiles(originals);
  assert.equal(result.patched, true);
  const patched = Object.fromEntries(Object.entries(result.files).map(([relative, content]) => [
    relative,
    content
      .replaceAll(SENTINEL, "// pui-subagents-patch:main-session-model-v3")
      .replace(JSON.stringify(POLICY_GUIDELINE), `'${POLICY_GUIDELINE}'`),
  ]));
  const manifest = {
    owner: "PUI",
    packageName: "@gotgenes/pi-subagents",
    packageVersion: "19.3.5",
    schemaVersion: 1,
    revision: 3,
    files: PATCH_FILES.map((relative) => ({
      path: relative,
      originalHash: sha256(originals[relative]),
      patchedHash: sha256(patched[relative]),
    })),
  };
  manifest.identityHash = sha256(JSON.stringify(manifest));
  for (const relative of PATCH_FILES) {
    fs.writeFileSync(path.join(dir, relative), patched[relative]);
    fs.writeFileSync(`${path.join(dir, relative)}.pui-original`, originals[relative]);
  }
  fs.writeFileSync(path.join(dir, ".pui-subagents-prompt-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

test("patchFiles describes user-configured mappings and inherited parent reasoning across every model-facing surface", () => {
  const { patchFiles, POLICY_GUIDELINE, MODEL_PARAMETER_DESCRIPTION, THINKING_PARAMETER_DESCRIPTION, PROMPT_SNIPPET, SENTINEL } = patchModule();
  const result = patchFiles(fixtureFiles());
  assert.equal(result.patched, true);
  const tool = result.files["src/tools/agent-tool.ts"];
  assert.match(tool, /user-configured fuzzy model mapping/);
  assert.match(tool, /inherits the parent session's active reasoning level/);
  assert.equal(tool.includes(POLICY_GUIDELINE), true);
  assert.equal(tool.includes(JSON.stringify(POLICY_GUIDELINE)), true, "policy guideline must remain a valid TypeScript string literal");
  assert.equal(tool.includes(MODEL_PARAMETER_DESCRIPTION), true);
  assert.equal(tool.includes(THINKING_PARAMETER_DESCRIPTION), true);
  assert.equal(tool.includes(PROMPT_SNIPPET), true);
  assert.equal(tool.includes("Use model to specify a different model"), false);
  assert.equal(tool.includes("Omit to use the agent type's default"), false);
  for (const content of Object.values(result.files)) assert.equal(content.includes(SENTINEL), true);
});

test("patchFiles detects a deleted upstream default reintroduced into an owned source", () => {
  const { patchFiles } = patchModule();
  const patched = patchFiles(fixtureFiles());
  assert.equal(patched.patched, true);
  patched.files["src/config/default-agents.ts"] = patched.files["src/config/default-agents.ts"].replace(
    '      systemPrompt: "read only",',
    '      model: "anthropic/claude-haiku-4-5-20251001",\n      systemPrompt: "read only",',
  );
  const result = patchFiles(patched.files);
  assert.equal(result.patched, false);
  assert.equal(result.reason, "patched-metadata-drift");
});

test("patchFiles loads fuzzy mappings from user config without embedding model names", () => {
  const { patchFiles } = patchModule();
  const result = patchFiles(fixtureFiles());
  assert.equal(result.patched, true);
  assert.equal(result.files["src/config/default-agents.ts"].includes("claude-haiku"), false);
  assert.match(result.files["src/config/invocation-config.ts"], /modelInput: params\.model,/);
  assert.match(result.files["src/config/invocation-config.ts"], /modelFromParams: params\.model != null/);
  assert.match(result.files["src/config/invocation-config.ts"], /thinking: params\.thinking/);
  assert.doesNotMatch(result.files["src/tools/spawn-config.ts"], /gpt-5\.6-(?:sol|luna)/);
  assert.match(result.files["src/tools/spawn-config.ts"], /resolveModel\(parentInput, modelInfo\.modelRegistry\)/);
  assert.match(result.files["src/tools/spawn-config.ts"], /resolvedConfig\.thinking \?\? modelInfo\.parentThinkingLevel/);
  assert.match(result.files["src/runtime.ts"], /loadPuiModelMappings/);
  assert.match(result.files["src/runtime.ts"], /parentThinkingLevel: this\.currentCtx\?\.thinkingLevel/);
  assert.match(result.files["src/types.ts"], /readonly thinkingLevel\?: ThinkingLevel/);
});

test("runtime resolution uses fuzzy config mappings, parent fallback, and explicit overrides", (t) => {
  const { patchFiles } = patchModule();
  const result = patchFiles(fixtureFiles());
  assert.equal(result.patched, true);
  const spawnSource = result.files["src/tools/spawn-config.ts"];
  const anchor = spawnSource.indexOf("/** Model info extracted from the parent session context. */");
  assert.notEqual(anchor, -1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-subagents-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtimeFile = path.join(dir, "spawn-config.ts");
  fs.writeFileSync(runtimeFile, `
    type Model<T> = { provider: string; id: string; name: string };
    type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    type ModelRegistry = any;
    type AgentDetails = any;
    function resolveAgentInvocationConfig(agentConfig: any, params: any) {
      return { modelInput: params.model, modelFromParams: params.model != null, thinking: params.thinking };
    }
    function resolveModel(input: string, registry: any) {
      const query = input.toLowerCase();
      return registry.models.find((model: any) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query)) ?? "not found";
    }
    function resolveInvocationModel(parent: any, input: string | undefined, explicit: boolean, registry: any) {
      if (!input) return { model: parent };
      if (!registry) return explicit ? { error: "registry missing" } : { model: parent };
      const model = resolveModel(input, registry);
      return typeof model !== "string" ? { model } : explicit ? { error: model } : { model: parent };
    }
    ${spawnSource.slice(anchor)}
  `);
  const script = `
    import { resolveSpawnConfig } from ${JSON.stringify(pathToFileURL(runtimeFile).href)};
    const sol = { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" };
    const luna = { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" };
    const registry = { resolveAgentConfig: () => ({ model: "profile/model", thinking: "minimal" }) };
    const available = { models: [sol, luna] };
    const info = { parentModel: sol, parentThinkingLevel: "xhigh", modelRegistry: available, modelMappings: { sol: "luna" } };
    const mapped = resolveSpawnConfig({}, registry, info, {});
    if (mapped.execution.model !== luna || mapped.execution.thinking !== "xhigh") throw new Error("mapped default failed");
    const explicit = resolveSpawnConfig({ model: "sol", thinking: "low" }, registry, info, {});
    if (explicit.execution.model !== sol || explicit.execution.thinking !== "low") throw new Error("explicit override failed");
    const unavailable = resolveSpawnConfig({}, registry, { ...info, parentThinkingLevel: "high", modelRegistry: { models: [sol] } }, {});
    if (unavailable.execution.model !== sol || unavailable.execution.thinking !== "high") throw new Error("fallback failed");
    const duplicate = resolveSpawnConfig({}, registry, { ...info, modelMappings: { sol: "luna", "gpt-5.6-sol": "luna" } }, {});
    if (!duplicate.error?.includes("Multiple configured mappings")) throw new Error("duplicate parent mapping was not rejected");
    const invalidConfig = resolveSpawnConfig({}, registry, { ...info, configError: "invalid config" }, {});
    if (invalidConfig.error !== "invalid config") throw new Error("config error was not surfaced");
    const explicitWithInvalidConfig = resolveSpawnConfig({ model: "sol" }, registry, { ...info, configError: "invalid config" }, {});
    if (explicitWithInvalidConfig.execution.model !== sol) throw new Error("explicit override did not bypass invalid mapping config");
  `;
  const runtime = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
});

test("runtime loader accepts fuzzy mapping config and reports missing or invalid files", (t) => {
  const { patchFiles } = patchModule();
  const result = patchFiles(fixtureFiles());
  assert.equal(result.patched, true);
  const runtimeSource = result.files["src/runtime.ts"];
  const start = runtimeSource.indexOf("const PUI_SUBAGENTS_CONFIG_PATH");
  const end = runtimeSource.indexOf("/**\n * Narrow config subset", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-subagents-config-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const moduleFile = path.join(dir, "loader.ts");
  fs.writeFileSync(moduleFile, `
    import { existsSync, readFileSync } from "node:fs";
    import { homedir } from "node:os";
    import { join } from "node:path";
    ${runtimeSource.slice(start, end)}
  `);
  const validFile = path.join(dir, "valid.json");
  const invalidFile = path.join(dir, "invalid.json");
  fs.writeFileSync(validFile, JSON.stringify({ schemaVersion: 1, modelMappings: { sol: "luna" }, _pui: { defaultMappings: { sol: "luna" } } }));
  fs.writeFileSync(invalidFile, JSON.stringify({ schemaVersion: 1, modelMappings: { sol: 42 } }));
  const script = `
    import { loadPuiModelMappings } from ${JSON.stringify(pathToFileURL(moduleFile).href)};
    const valid = loadPuiModelMappings(${JSON.stringify(validFile)});
    if (valid.error || valid.modelMappings.sol !== "luna") throw new Error("valid config failed");
    if (!loadPuiModelMappings(${JSON.stringify(invalidFile)}).error?.includes("invalid")) throw new Error("invalid config accepted");
    if (!loadPuiModelMappings(${JSON.stringify(path.join(dir, "missing.json"))}).error?.includes("missing")) throw new Error("missing config accepted");
  `;
  const runtime = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
});

test("runtime config ignores profile model and thinking defaults while explicit invocation overrides win", (t) => {
  const { apply } = patchModule();
  const dir = makePackage();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(apply(dir).ok, true);
  const invocationFile = path.join(dir, "src/config/invocation-config.ts");
  const script = `
    import { resolveAgentInvocationConfig } from ${JSON.stringify(pathToFileURL(invocationFile).href)};
    const inherited = resolveAgentInvocationConfig({ model: "profile/model", thinking: "minimal" }, {});
    if (inherited.modelInput !== undefined || inherited.modelFromParams !== false || inherited.thinking !== undefined) {
      throw new Error(JSON.stringify(inherited));
    }
    const explicit = resolveAgentInvocationConfig(
      { model: "profile/model", thinking: "minimal" },
      { model: "provider/requested", thinking: "high" },
    );
    if (explicit.modelInput !== "provider/requested" || explicit.modelFromParams !== true || explicit.thinking !== "high") {
      throw new Error(JSON.stringify(explicit));
    }
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("apply migrates the original PUI-owned shape to the current policy", (t) => {
  const { apply, verify, PATCH_FILES } = patchModule();
  const dir = makePackage();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installLegacyV1Shape(dir);

  const result = apply(dir);
  assert.equal(result.ok, true);
  assert.equal(result.action, "migrated");
  assert.equal(verify(dir).ok, true);
  for (const relative of PATCH_FILES) {
    assert.equal(fs.existsSync(`${path.join(dir, relative)}.pui-original`), true);
  }
});

test("legacy migration accepts package reconciliation that restored owned sources", (t) => {
  const { apply, verify } = patchModule();
  const dir = makePackage();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installLegacyV1Shape(dir);
  for (const relative of [
    "src/tools/agent-tool.ts",
    "src/config/default-agents.ts",
    "src/config/invocation-config.ts",
  ]) {
    fs.copyFileSync(`${path.join(dir, relative)}.pui-original`, path.join(dir, relative));
  }

  const result = apply(dir);
  assert.equal(result.ok, true);
  assert.equal(result.action, "migrated");
  assert.equal(verify(dir).ok, true);
});

test("apply upgrades the exact broken revision 3 guideline literal", (t) => {
  const { apply, verify, POLICY_GUIDELINE } = patchModule();
  const dir = makePackage();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installBrokenRevision3Shape(dir);

  const result = apply(dir);
  assert.equal(result.ok, true);
  assert.equal(result.action, "updated");
  assert.equal(verify(dir).ok, true);
  const tool = fs.readFileSync(path.join(dir, "src/tools/agent-tool.ts"), "utf8");
  assert.equal(tool.includes(JSON.stringify(POLICY_GUIDELINE)), true);
});

test("apply is version-anchored, idempotent, owned, and removable", (t) => {  const { apply, verify, remove, backupFile, manifestFile, PATCH_FILES } = patchModule();
  const dir = makePackage();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const originals = Object.fromEntries(PATCH_FILES.map((relative) => [relative, fs.readFileSync(path.join(dir, relative), "utf8")]));
  assert.equal(apply(dir).action, "patched");
  assert.equal(verify(dir).ok, true);
  assert.equal(apply(dir).action, "already-patched");
  const manifest = JSON.parse(fs.readFileSync(manifestFile(dir), "utf8"));
  assert.equal(manifest.owner, "PUI");
  assert.equal(manifest.packageVersion, "19.3.5");
  for (const relative of PATCH_FILES) assert.equal(fs.readFileSync(backupFile(dir, relative), "utf8"), originals[relative]);
  assert.equal(remove(dir).action, "restored");
  for (const relative of PATCH_FILES) assert.equal(fs.readFileSync(path.join(dir, relative), "utf8"), originals[relative]);
});

test("apply and remove fail closed on version or installed drift", (t) => {
  const { apply, remove, PATCH_FILES } = patchModule();
  const wrong = makePackage("19.3.6");
  const dir = makePackage();
  t.after(() => fs.rmSync(wrong, { recursive: true, force: true }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(apply(wrong).reason, "version-mismatch");
  apply(dir);
  fs.appendFileSync(path.join(dir, PATCH_FILES[0]), "\n// user drift\n");
  assert.equal(remove(dir).action, "preserved");
});

test("snapshot restoration reverses an introducing lifecycle patch", (t) => {
  const { apply, snapshot, restoreSnapshot, PATCH_FILES, manifestFile } = patchModule();
  const dir = makePackage();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pui-subagents-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const originals = Object.fromEntries(PATCH_FILES.map((relative) => [relative, fs.readFileSync(path.join(dir, relative), "utf8")]));
  assert.equal(snapshot(state, dir).ok, true);
  assert.equal(apply(dir).ok, true);
  assert.equal(restoreSnapshot(state, dir).ok, true);
  assert.equal(fs.existsSync(manifestFile(dir)), false);
  for (const relative of PATCH_FILES) assert.equal(fs.readFileSync(path.join(dir, relative), "utf8"), originals[relative]);
});
