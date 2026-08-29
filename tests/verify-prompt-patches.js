#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const backgroundTasksPatch = require("../lib/pui-background-tasks-patch.js");
const subagentsPatch = require("../lib/pui-subagents-patch.js");

const repoRoot = path.resolve(__dirname, "..");
const stack = require("../stack.json");

function npmCommand(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) return [process.execPath, npmExecPath, ...args];
  if (process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCli)) return [process.execPath, npmCli, ...args];
    return ["npm.cmd", ...args];
  }
  return ["npm", ...args];
}

function packageDir(root, packagePath) {
  return path.resolve(root, ...packagePath.split("/"));
}

function readSources(packageDir, files) {
  return Object.fromEntries(files.map((relative) => [
    relative,
    fs.readFileSync(path.join(packageDir, ...relative.split("/")), "utf8"),
  ]));
}

function assertSubagentsArtifact(packageDir, runtimeRoot) {
  const config = stack.subagentsPromptPatch;
  const files = config.files;
  const originals = readSources(packageDir, files);
  assert.equal(subagentsPatch.apply(packageDir).action, "patched");
  const toolSource = fs.readFileSync(path.join(packageDir, "src", "tools", "agent-tool.ts"), "utf8");
  assert.match(toolSource, new RegExp(JSON.stringify(subagentsPatch.POLICY_GUIDELINE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const invocationFile = path.join(packageDir, "src", "config", "invocation-config.ts");
  const invocationSource = fs.readFileSync(invocationFile, "utf8");
  assert.match(invocationSource, /modelInput: params\.model,/);
  assert.match(invocationSource, /thinking: params\.thinking as ThinkingLevel/);
  assert.doesNotMatch(invocationSource, /agentConfig\?\.(model|thinking)/);
  const spawnFile = path.join(packageDir, "src", "tools", "spawn-config.ts");
  const spawnSource = fs.readFileSync(spawnFile, "utf8");
  assert.doesNotMatch(spawnSource, /gpt-5\.6-(?:sol|luna)/);
  assert.match(spawnSource, /resolveModel\(parentInput, modelInfo\.modelRegistry\)/);
  assert.match(spawnSource, /resolvedConfig\.thinking \?\? modelInfo\.parentThinkingLevel/);
  const subagentRuntimeSource = fs.readFileSync(path.join(packageDir, "src", "runtime.ts"), "utf8");
  assert.match(subagentRuntimeSource, /\.config", "pui", "subagents\.json"/);
  assert.match(subagentRuntimeSource, /parentThinkingLevel: this\.currentCtx\?\.thinkingLevel/);
  assert.match(fs.readFileSync(path.join(packageDir, "src", "types.ts"), "utf8"), /readonly thinkingLevel\?: ThinkingLevel/);

  const runtimeCheckDir = path.join(runtimeRoot, "prompt-patch-runtime-check");
  fs.mkdirSync(runtimeCheckDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeCheckDir, "package.json"), JSON.stringify({ type: "module" }) + "\n", "utf8");
  const runtimeSpawnFile = path.join(runtimeCheckDir, "spawn-config.ts");
  const spawnRuntimeAnchor = spawnSource.indexOf("/** Model info extracted from the parent session context. */");
  assert.notEqual(spawnRuntimeAnchor, -1, "spawn-config runtime extraction anchor missing");
  const executableSpawnSource = spawnSource.slice(spawnRuntimeAnchor);
  fs.writeFileSync(runtimeSpawnFile, `
    type Model<T> = { provider: string; id: string; name: string };
    type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    type AgentInvocation = Record<string, unknown>;
    type SubagentType = string;
    type AgentDetails = Record<string, unknown>;
    type ModelRegistry = {
      find(provider: string, id: string): Model<any> | undefined;
      getAll(): Model<any>[];
      getAvailable?(): Model<any>[];
    };
    type AgentTypeRegistry = any;
    function resolveAgentInvocationConfig(agentConfig: any, params: any) {
      return {
        modelInput: params.model,
        modelFromParams: params.model != null,
        thinking: params.thinking,
        inheritContext: params.inherit_context ?? agentConfig?.inheritContext ?? false,
        runInBackground: params.run_in_background ?? agentConfig?.runInBackground ?? false,
        maxTurns: params.max_turns ?? agentConfig?.maxTurns,
      };
    }
    function resolveModel(input: string, registry: ModelRegistry) {
      const all = registry.getAvailable?.() ?? registry.getAll();
      const query = input.toLowerCase();
      return all.find((model) =>
        \`${"${model.provider}/${model.id}"}\`.toLowerCase() === query ||
        model.id.toLowerCase().includes(query) ||
        model.name.toLowerCase().includes(query)) ?? "not found";
    }
    function resolveInvocationModel(parentModel: Model<any> | undefined, input: string | undefined, fromParams: boolean, registry: ModelRegistry | undefined) {
      if (!input) return { model: parentModel };
      if (!registry) return fromParams ? { error: "No model registry available." } : { model: parentModel };
      const found = resolveModel(input, registry);
      return typeof found !== "string" ? { model: found } : fromParams ? { error: found } : { model: parentModel };
    }
    function normalizeMaxTurns(value: unknown) { return typeof value === "number" ? value : undefined; }
    function getDisplayName(type: string, registry: any) { const config = registry.resolveAgentConfig(type); return config.displayName ?? config.name; }
    function getPromptModeLabel() { return undefined; }
    function buildInvocationTags() { return { tags: [] }; }
    ${executableSpawnSource}
  `, "utf8");
  const runtimeCheck = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    `
      import { resolveSpawnConfig } from ${JSON.stringify(pathToFileURL(runtimeSpawnFile).href)};
      const sol = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" };
      const luna = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT 5.6 Luna" };
      const registry = {
        resolveType: (type) => type,
        isValidType: () => true,
        resolveAgentConfig: () => ({ name: "general-purpose", displayName: "General", promptMode: "replace", model: "profile/model", thinking: "minimal" }),
      };
      const modelRegistry = {
        getAll: () => [sol, luna],
        getAvailable: () => [sol, luna],
        find: (provider, id) => [sol, luna].find((model) => model.provider === provider && model.id === id),
      };
      const params = { subagent_type: "general-purpose", prompt: "test", description: "test" };
      const settings = { defaultMaxTurns: undefined };
      const mappings = { sol: "luna" };
      const mapped = resolveSpawnConfig(params, registry, { parentModel: sol, parentThinkingLevel: "xhigh", modelRegistry, modelMappings: mappings }, settings);
      if (mapped.execution.model !== luna || mapped.execution.thinking !== "xhigh") throw new Error("mapped default failed");
      const explicit = resolveSpawnConfig({ ...params, model: "sol", thinking: "low" }, registry, { parentModel: sol, parentThinkingLevel: "xhigh", modelRegistry, modelMappings: mappings }, settings);
      if (explicit.execution.model !== sol || explicit.execution.thinking !== "low") throw new Error("explicit override failed");
      const parentOnlyRegistry = { getAll: () => [sol], getAvailable: () => [sol], find: () => undefined };
      const unavailable = resolveSpawnConfig(params, registry, { parentModel: sol, parentThinkingLevel: "high", modelRegistry: parentOnlyRegistry, modelMappings: mappings }, settings);
      if (unavailable.execution.model !== sol || unavailable.execution.thinking !== "high") throw new Error("unavailable mapping fallback failed");
      const noRegistry = resolveSpawnConfig(params, registry, { parentModel: sol, parentThinkingLevel: "medium", modelRegistry: undefined, modelMappings: mappings }, settings);
      if (noRegistry.execution.model !== sol || noRegistry.execution.thinking !== "medium") throw new Error("missing registry fallback failed");
    `,
  ], { cwd: runtimeCheckDir, encoding: "utf8", windowsHide: true });
  assert.equal(runtimeCheck.status, 0, runtimeCheck.stderr || runtimeCheck.stdout);

  const jitiFile = path.join(runtimeRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "jiti", "lib", "jiti.cjs");
  const importCheck = spawnSync(process.execPath, [
    "--eval",
    `
      const path = require("node:path");
      const createJiti = require(process.argv[1]);
      const jiti = createJiti(path.join(process.argv[2], "verify.cjs"), { moduleCache: false, tryNative: false });
      jiti.import(process.argv[3], { default: true }).then((factory) => {
        if (typeof factory !== "function") throw new Error("extension does not export a factory");
      }).catch((error) => { console.error(error); process.exit(1); });
    `,
    jitiFile,
    runtimeRoot,
    path.join(packageDir, "src", "index.ts"),
  ], { cwd: runtimeRoot, encoding: "utf8", windowsHide: true });
  assert.equal(importCheck.status, 0, importCheck.stderr || importCheck.stdout);
  assert.equal(subagentsPatch.verify(packageDir).ok, true);
  assert.equal(subagentsPatch.apply(packageDir).action, "already-patched");
  assert.equal(subagentsPatch.remove(packageDir).action, "restored");
  for (const relative of files) {
    const file = path.join(packageDir, ...relative.split("/"));
    assert.equal(fs.readFileSync(file, "utf8"), originals[relative], relative);
    assert.equal(fs.existsSync(`${file}${config.backupSuffix}`), false, `${relative} backup remains`);
  }
  assert.equal(fs.existsSync(path.join(packageDir, config.manifest)), false, "subagent ownership manifest remains");
}

function assertBackgroundTasksArtifact(packageDir) {
  const config = stack.backgroundTasksPromptPatch;
  const file = path.join(packageDir, config.bundle);
  const original = fs.readFileSync(file, "utf8");
  assert.equal(backgroundTasksPatch.apply(packageDir).action, "patched");
  assert.equal(backgroundTasksPatch.verify(packageDir).ok, true);
  assert.equal(backgroundTasksPatch.apply(packageDir).action, "already-patched");
  assert.equal(backgroundTasksPatch.remove(packageDir).action, "restored");
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.existsSync(`${file}${config.backupSuffix}`), false, "background-task backup remains");
  assert.equal(fs.existsSync(`${file}${config.manifestSuffix}`), false, "background-task ownership manifest remains");
}

function installArtifacts(root) {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true }) + "\n", "utf8");
  const specs = [
    `${stack.upstream.subagents.npm}@${stack.upstream.subagents.version}`,
    `${stack.upstream.backgroundTasks.npm}@${stack.upstream.backgroundTasks.version}`,
    `${stack.upstream.agentRuntime.npm}@${stack.upstream.agentRuntime.version}`,
  ];
  const args = [
    "install",
    "--prefix",
    root,
    "--install-strategy=nested",
    "--ignore-scripts",
    "--omit=peer",
    "--no-package-lock",
    "--no-save",
    "--no-audit",
    "--no-fund",
    ...specs,
  ];
  const [executable, ...commandArgs] = npmCommand(args);
  const result = spawnSync(executable, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
    shell: executable === "npm.cmd",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install failed with exit ${result.status}`);
}

function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-prompt-patches-artifact-"));
  try {
    installArtifacts(temp);
    assertSubagentsArtifact(packageDir(temp, stack.subagentsPromptPatch.packagePath), temp);
    assertBackgroundTasksArtifact(packageDir(temp, stack.backgroundTasksPromptPatch.packagePath));
    console.log(`Published ${stack.upstream.subagents.npm}@${stack.upstream.subagents.version} and ${stack.upstream.backgroundTasks.npm}@${stack.upstream.backgroundTasks.version} prompt patch artifacts passed`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main();
