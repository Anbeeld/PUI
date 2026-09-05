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
  for (const rule of subagentsPatch.PARENT_OWNERSHIP_GUIDELINES) assert.equal(toolSource.split(rule).length - 1, 1);
  assert.match(toolSource, /Default: launch background specialists only for substantial independent work concurrent with main or another agent\./);
  assert.doesNotMatch(toolSource, /Profile fit selects a capability only after the parallelism gate passes/);
  assert.equal(toolSource.split("Default is background").length - 1, 1);
  assert.doesNotMatch(toolSource, /autonomously handle complex tasks|Run background agents in parallel only when/);
  assert.match(toolSource, /Never delegate decisions\./);
  assert.match(toolSource, /delegate only with substantial disjoint main work or at least two independent concurrent children; otherwise stay in main/);
  assert.match(toolSource, /Preassign disjoint ownership: bounded deliverable, owned\/excluded files\/sources\/actions/);
  assert.match(toolSource, /After dispatch, do reserved main work before waiting/);
  assert.match(toolSource, /Until collection, do not duplicate child evidence, edits, or checks/);
  assert.match(toolSource, /route by capability: readable static files → Explore; external\/current sources → Research; commands, Git, builds, tests, experiments, or edits → Worker\/main/);
  assert.match(toolSource, /foreground requires explicit user request, not profile naming\./);
  assert.match(toolSource, /Reload resolves changes\./);
  assert.equal(toolSource.split("Resume only with new direction").length - 1, 1);
  assert.doesNotMatch(toolSource, /Use resume with an agent ID to continue a previous agent's work/);
  assert.match(toolSource, /Give Explore an other-revision diff or checkout; otherwise use Worker\/main/);
  assert.match(toolSource, /Match results to deliverables and fields/);
  assert.match(toolSource, /missing status\/coverage/);
  assert.match(toolSource, /errors, empty output, aborts, stops, limit steering, or residual work are incomplete/);
  assert.match(toolSource, /critical-path follow-ups stay in main/);
  assert.match(toolSource, /other fields are ignored/);
  assert.match(toolSource, /A circuit breaker, not task sizing/);
  assert.match(toolSource, /A limit stop is incomplete/);
  assert.match(toolSource, /Custom agents use same gate unless user-named/);
  assert.match(toolSource, /Omitted uses the selected profile default \(PUI built-ins: background; no profile default: foreground\)\. Use false only for an explicit user request\./);
  assert.doesNotMatch(toolSource, /Use foreground when|substantial intermediate output justifies|work would consume many tool calls|Default routes: local static evidence|sequence them through main|PUI built-ins: false|target count|concurrency limit|max concurrency|capacity is available/);
  const defaultsSource = fs.readFileSync(path.join(packageDir, "src", "config", "default-agents.ts"), "utf8");
  assert.match(defaultsSource, /\["web_search", "source_check", "fetch_content", "get_search_content"\]/);
  assert.match(defaultsSource, /Your available tools are exactly: read, bash, edit, write, grep, find, ls, and load_skill\./);
  assert.match(defaultsSource, /Your available tools are exactly: read, grep, find, ls, and load_skill\./);
  assert.match(defaultsSource, /Never choose, recommend, rank, approve, assign severity, or decide what to use or port\./);
  assert.match(defaultsSource, /If asked, return only supporting evidence and mark the decision out of scope\./);
  assert.match(defaultsSource, /Your available tools are exactly: read, grep, find, ls, load_skill, web_search, source_check, fetch_content, and get_search_content\./);
  assert.match(defaultsSource, /Check accessibility before searching\./);
  assert.match(defaultsSource, /Never cite one revision for another\./);
  assert.match(defaultsSource, /do not substitute a proposed experiment\./);
  assert.match(defaultsSource, /not invitations to propose unexecuted experiments\./);
  assert.match(defaultsSource, /Use the smallest sufficient evidence set; do not repeat equivalent scans once evidence suffices\./);
  assert.equal(defaultsSource.split("Return all fields (none if empty):").length - 1, 3);
  assert.equal(defaultsSource.split("runInBackground: true").length - 1, 3);
  assert.doesNotMatch(defaultsSource, /anthropic\/claude-haiku/);
  const agentTypesSource = fs.readFileSync(path.join(packageDir, "src", "config", "agent-types.ts"), "utf8");
  assert.match(agentTypesSource, /DEFAULT_AGENT_NAMES = \["Worker", "Explore", "Research"\]/);
  assert.match(agentTypesSource, /const existing = this\.resolveKey\(name\)/);
  assert.match(agentTypesSource, /this\.agents\.get\(workerKey\)/);
  assert.doesNotMatch(agentTypesSource, /this\.agents\.get\("general-purpose"\)/);
  const invocationFile = path.join(packageDir, "src", "config", "invocation-config.ts");
  const invocationSource = fs.readFileSync(invocationFile, "utf8");
  assert.match(invocationSource, /modelInput: params\.model,/);
  assert.match(invocationSource, /thinking: params\.thinking as ThinkingLevel/);
  assert.match(invocationSource, /maxTurns: params\.max_turns \?\? agentConfig\?\.maxTurns/);
  assert.match(invocationSource, /runInBackground: params\.run_in_background \?\? agentConfig\?\.runInBackground \?\? false/);
  assert.doesNotMatch(invocationSource, /agentConfig\?\.(model|thinking)/);
  const spawnFile = path.join(packageDir, "src", "tools", "spawn-config.ts");
  const spawnSource = fs.readFileSync(spawnFile, "utf8");
  assert.doesNotMatch(spawnSource, /gpt-5\.6-(?:sol|luna)/);
  assert.match(spawnSource, /resolveModel\(parentInput, modelInfo\.modelRegistry\)/);
  assert.match(spawnSource, /resolvedConfig\.thinking \?\? modelInfo\.parentThinkingLevel/);
  assert.match(spawnSource, /Unknown agent type/);
  assert.doesNotMatch(spawnSource, /resolved \?\? "general-purpose"/);
  const subagentRuntimeSource = fs.readFileSync(path.join(packageDir, "src", "runtime.ts"), "utf8");
  assert.match(subagentRuntimeSource, /\.config", "pui", "subagents\.json"/);
  assert.match(subagentRuntimeSource, /parentThinkingLevel: this\.currentCtx\?\.thinkingLevel/);
  assert.match(fs.readFileSync(path.join(packageDir, "src", "types.ts"), "utf8"), /readonly thinkingLevel\?: ThinkingLevel/);
  const notificationSource = fs.readFileSync(path.join(packageDir, "src", "observation", "notification.ts"), "utf8");
  assert.match(notificationSource, /onParentTurnEnd\(\): void/);
  assert.match(notificationSource, /flushPendingNudges\("steer"\)/);
  assert.match(notificationSource, /flushPendingNudges\("followUp"\)/);
  assert.match(fs.readFileSync(path.join(packageDir, "src", "index.ts"), "utf8"), /pi\.on\("turn_end", \(\) => notifications\.onParentTurnEnd\(\)\)/);
  const settingsSource = fs.readFileSync(path.join(packageDir, "src", "settings.ts"), "utf8");
  assert.match(settingsSource, /const DEFAULT_MAX_CONCURRENT = 128;/);
  assert.match(settingsSource, /const MAX_CONCURRENT_CEILING = 128;/);
  const limiterSource = fs.readFileSync(path.join(packageDir, "src", "lifecycle", "concurrency-limiter.ts"), "utf8");
  assert.match(limiterSource, /private readonly maxQueued = 512/);
  assert.match(limiterSource, /this\.pending\.length < this\.maxQueued/);
  const managerSource = fs.readFileSync(path.join(packageDir, "src", "lifecycle", "subagent-manager.ts"), "utf8");
  assert.match(managerSource, /!this\.limiter\.canSchedule\(\)/);
  assert.match(managerSource, /Background agent queue is full/);
  const subagentSessionFile = path.join(packageDir, "src", "lifecycle", "subagent-session.ts");
  const subagentSessionSource = fs.readFileSync(subagentSessionFile, "utf8");
  assert.match(subagentSessionSource, /last\.stopReason === "error"/);
  assert.match(subagentSessionSource, /Partial output:/);
  assert.match(subagentSessionSource, /Subagent completed without output/);
  const subagentStateSource = fs.readFileSync(path.join(packageDir, "src", "lifecycle", "subagent-state.ts"), "utf8");
  assert.match(subagentStateSource, /\|\| status === "steered"/);
  assert.doesNotMatch(subagentStateSource, /excludes the successful `steered`/);
  assert.match(fs.readFileSync(path.join(packageDir, "src", "observation", "notification.ts"), "utf8"), /Incomplete \(turn limit\)/);
  const rendererSource = fs.readFileSync(path.join(packageDir, "src", "observation", "renderer.ts"), "utf8");
  assert.match(rendererSource, /"incomplete \(turn limit\)"/);
  assert.doesNotMatch(rendererSource, /"completed \(steered\)"/);
  const resultReportFile = path.join(packageDir, "src", "tools", "get-result-report.ts");
  assert.match(fs.readFileSync(resultReportFile, "utf8"), /return report\.result\?\.trim\(\) \|\| "No output\."/);

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
        resolveType: (type) => type === "Worker" ? "Worker" : undefined,
        isValidType: () => true,
        getAvailableTypes: () => ["Worker", "Explore", "Research"],
        resolveAgentConfig: () => ({ name: "Worker", displayName: "Worker", promptMode: "append", model: "profile/model", thinking: "minimal" }),
      };
      const modelRegistry = {
        getAll: () => [sol, luna],
        getAvailable: () => [sol, luna],
        find: (provider, id) => [sol, luna].find((model) => model.provider === provider && model.id === id),
      };
      const params = { subagent_type: "Worker", prompt: "test", description: "test" };
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
      const unknown = resolveSpawnConfig({ ...params, subagent_type: "Reserach" }, registry, { parentModel: sol, parentThinkingLevel: "medium", modelRegistry, modelMappings: mappings }, settings);
      if (!unknown.error?.includes("Unknown agent type") || "execution" in unknown) throw new Error("unknown type fell through");
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

  const resultIntegrityCheck = spawnSync(process.execPath, [
    "--eval",
    `
      const path = require("node:path");
      const createJiti = require(process.argv[1]);
      const jiti = createJiti(path.join(process.argv[2], "result-integrity-check.cjs"), { moduleCache: false, tryNative: false });
      jiti.import(process.argv[3]).then(async ({ SubagentSession }) => {
        async function run(message) {
          let completed = 0;
          const session = {
            messages: [],
            subscribe() { return () => {}; },
            async prompt() { this.messages.push(message); },
          };
          const wrapped = new SubagentSession(session, {
            outputFile: undefined,
            sessionId: "test",
            sessionDir: "test",
            agentName: "Explore",
            agentMaxTurns: undefined,
            parentContext: undefined,
            lifecycle: { completed() { completed++; } },
          });
          try {
            const result = await wrapped.runTurnLoop("test", {});
            return { result, completed };
          } catch (error) {
            return { error: error.message, completed };
          }
        }
        const providerError = await run({ role: "assistant", content: [], stopReason: "error", errorMessage: "usage exhausted" });
        if (providerError.error !== "usage exhausted" || providerError.completed !== 0) throw new Error("provider error became completion: " + JSON.stringify(providerError));
        const partial = await run({ role: "assistant", content: [{ type: "text", text: "useful partial" }], stopReason: "error", errorMessage: "usage exhausted" });
        if (partial.error !== "usage exhausted\\n\\nPartial output:\\nuseful partial" || partial.completed !== 0) throw new Error("provider partial output was lost: " + JSON.stringify(partial));
        const empty = await run({ role: "assistant", content: [], stopReason: "stop" });
        if (empty.error !== "Subagent completed without output." || empty.completed !== 0) throw new Error("empty response became completion: " + JSON.stringify(empty));
        const success = await run({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
        if (success.result?.responseText !== "done" || success.completed !== 1) throw new Error("valid response failed: " + JSON.stringify(success));
      }).catch((error) => { console.error(error); process.exit(1); });
    `,
    jitiFile,
    runtimeRoot,
    subagentSessionFile,
  ], { cwd: runtimeRoot, encoding: "utf8", windowsHide: true });
  assert.equal(resultIntegrityCheck.status, 0, resultIntegrityCheck.stderr || resultIntegrityCheck.stdout);

  const profileRoot = path.join(runtimeRoot, "profile-overlay-check");
  const profileProject = path.join(profileRoot, "project");
  fs.mkdirSync(path.join(profileRoot, "agents"), { recursive: true });
  fs.mkdirSync(path.join(profileProject, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(profileRoot, "agents", "Explore.md"), "---\ndescription: global override\n---\nglobal\n");
  fs.writeFileSync(path.join(profileRoot, "agents", "Custom.md"), "---\ndescription: added profile\n---\ncustom\n");
  fs.writeFileSync(path.join(profileProject, ".pi", "agents", "explore.md"), "---\ndescription: project override\nenabled: false\n---\nproject\n");

  const renderedCheck = spawnSync(process.execPath, [
    "--eval",
    `
      const path = require("node:path");
      const createJiti = require(process.argv[1]);
      const jiti = createJiti(path.join(process.argv[2], "rendered-policy-check.cjs"), { moduleCache: false, tryNative: false });
      Promise.all([
        jiti.import(process.argv[3]),
        jiti.import(process.argv[4]),
        jiti.import(process.argv[5]),
        jiti.import(process.argv[6]),
        jiti.import(process.argv[7]),
      ]).then(([defaultsModule, typesModule, promptsModule, toolModule, customAgentsModule]) => {
        const { DEFAULT_AGENTS } = defaultsModule;
        const { AgentTypeRegistry } = typesModule;
        const { buildAgentPrompt } = promptsModule;
        const { AgentTool } = toolModule;
        const names = [...DEFAULT_AGENTS.keys()];
        if (JSON.stringify(names) !== JSON.stringify(["Worker", "Explore", "Research"])) throw new Error("default taxonomy drifted: " + JSON.stringify(names));
        const registry = new AgentTypeRegistry(() => new Map());
        const builtins = ["read", "bash", "edit", "write", "grep", "find", "ls", "load_skill"];
        if (JSON.stringify(registry.getToolNamesForType("Worker")) !== JSON.stringify(builtins)) throw new Error("Worker tools drifted");
        if (JSON.stringify(registry.getToolNamesForType("Explore")) !== JSON.stringify(["read", "grep", "find", "ls", "load_skill"])) throw new Error("Explore tools drifted");
        if (JSON.stringify(registry.getToolNamesForType("Research")) !== JSON.stringify(["read", "grep", "find", "ls", "load_skill", "web_search", "source_check", "fetch_content", "get_search_content"])) throw new Error("Research tools drifted");
        if (registry.resolveType("Plan") !== undefined || registry.resolveType("general-purpose") !== undefined) throw new Error("removed built-in alias remains");
        const customRegistry = new AgentTypeRegistry(() => new Map([
          ["Plan", { name: "Plan", description: "custom", systemPrompt: "custom", promptMode: "append" }],
          ["general-purpose", { name: "general-purpose", description: "custom", systemPrompt: "custom", promptMode: "append" }],
        ]));
        if (customRegistry.resolveType("PLAN") !== "Plan" || customRegistry.resolveType("GENERAL-PURPOSE") !== "general-purpose") throw new Error("custom removed-name profiles failed");
        const caseOverrideRegistry = new AgentTypeRegistry(() => new Map([
          ["explore", { name: "explore", description: "user override", systemPrompt: "custom", promptMode: "append", toolNames: ["read"] }],
          ["Custom", { name: "Custom", description: "added profile", systemPrompt: "custom", promptMode: "append" }],
        ]));
        if (caseOverrideRegistry.resolveType("Explore") !== "explore" || caseOverrideRegistry.getDefaultAgentNames().includes("Explore")) throw new Error("case-variant default override failed");
        if (caseOverrideRegistry.resolveAgentConfig("EXPLORE").description !== "user override") throw new Error("case-variant override config failed");
        if (!caseOverrideRegistry.getUserAgentNames().includes("Custom")) throw new Error("added custom profile missing");
        const loadedProfiles = customAgentsModule.loadCustomAgents(process.argv[8]);
        const fileRegistry = new AgentTypeRegistry(() => loadedProfiles);
        if (fileRegistry.resolveType("EXPLORE") !== "explore") throw new Error("project case-variant profile did not override global/default");
        if (fileRegistry.isValidType("Explore") !== false || fileRegistry.resolveAgentConfig("Explore").description !== "project override") throw new Error("disabled project override was not preserved");
        if (!fileRegistry.getUserAgentNames().includes("Custom")) throw new Error("filesystem custom profile missing");
        const env = { isGitRepo: true, branch: "main", platform: "win32" };
        const skillBlock = "\\n\\nThe following skills provide specialized instructions for specific tasks.\\nUse the read tool to load a skill's file when the task matches its description.\\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\\n\\n<available_skills>\\n  <skill><name>sample</name></skill>\\n</available_skills>";
        const parentPrompt = [
          "AUTHORITY_RULE: preserve inherited authority.",
          "",
          "Available tools:",
          "- parent_only_tool: unavailable to children",
          "",
          "In addition to the tools above, you may have access to other custom tools depending on the project.",
          "",
          "Guidelines:",
          ...${JSON.stringify(subagentsPatch.PARENT_OWNERSHIP_GUIDELINES)},
          "",
          "Pi documentation (preserved heading)",
          "PROJECT_RULE: preserve project instructions.",
        ].join("\\n") + skillBlock;
        const inherited = { systemPrompt: parentPrompt, cwd: "C:/repo" };
        const exactTools = {
          Worker: "read, bash, edit, write, grep, find, ls, and load_skill",
          Explore: "read, grep, find, ls, and load_skill",
          Research: "read, grep, find, ls, load_skill, web_search, source_check, fetch_content, and get_search_content",
        };
        for (const name of names) {
          const config = DEFAULT_AGENTS.get(name);
          if (config.runInBackground !== true) throw new Error(name + " does not default to background execution");
          const rendered = buildAgentPrompt(config, "C:/repo", env, inherited);
          for (const kept of ["AUTHORITY_RULE", "PROJECT_RULE"]) if (!rendered.includes(kept)) throw new Error(name + " lost " + kept);
          for (const removed of ["parent_only_tool", "<available_skills>", ${JSON.stringify(subagentsPatch.PARENT_OWNERSHIP_GUIDELINES[0])}]) if (rendered.includes(removed)) throw new Error(name + " retained " + removed);
          if (!config.systemPrompt.includes("Your available tools are exactly: " + exactTools[name] + ".")) throw new Error(name + " prompt/tool allowlist mismatch");
          if ((rendered + skillBlock).split("<available_skills>").length - 1 !== 1) throw new Error(name + " duplicates child skills");
          if (rendered.trim().split(/\\s+/).length > 400) throw new Error(name + " effective fixed prompt exceeds 400 words");
          if (name === "Worker") {
            if (!rendered.endsWith("<agent_instructions>\\n" + config.systemPrompt + "\\n</agent_instructions>")) throw new Error("Worker contract is not the final specialist content");
          } else if (!rendered.endsWith(config.systemPrompt)) throw new Error(name + " specialist prompt is not last");
        }
        const definition = new AgentTool({}, {}, { defaultMaxTurns: undefined, maxConcurrent: 4 }, registry, process.argv[2]).toToolDefinition();
        const wordCount = (text) => String(text ?? "").trim().split(/\\s+/).filter(Boolean).length;
        const parameterText = Object.values(definition.parameters.properties).map((schema) => schema.description ?? "").join("\\n");
        const descriptionWords = wordCount(definition.description);
        const interfaceWords = wordCount(definition.description + "\\n" + parameterText);
        if (definition.description.includes("\\n\\n\\n")) throw new Error("parent tool description has redundant blank paragraphs");
        if (descriptionWords > 460) throw new Error("parent tool description exceeds 460 words: " + descriptionWords);
        if (interfaceWords > 680) throw new Error("complete parent-facing interface exceeds 680 words: " + interfaceWords);
        for (const rule of ${JSON.stringify(subagentsPatch.PARENT_OWNERSHIP_GUIDELINES)}) {
          if (definition.description.split(rule).length - 1 !== 1) throw new Error("parent rule missing or duplicated: " + rule);
        }
        for (const name of names) if (!definition.description.includes(DEFAULT_AGENTS.get(name).toolGuideline)) throw new Error(name + " route guideline missing");
        if (definition.description.includes("Use Plan for architecture")) throw new Error("Plan route remains");
        if (definition.description.includes("Provide clear, detailed prompts so the agent can work autonomously")) throw new Error("redundant generic prompt guidance remains");
        const promptDescription = definition.parameters.properties.prompt.description;
        if (!promptDescription.includes("One distinct delegated deliverable") || !promptDescription.includes("Name ownership, exclusions, evidence, output, stop, and any reserved main track")) throw new Error("prompt parameter does not enforce distinct ownership");
        const backgroundDescription = definition.parameters.properties.run_in_background.description;
        if (!backgroundDescription.includes("PUI built-ins: background; no profile default: foreground") || !backgroundDescription.includes("Omitted uses the selected profile default") || !backgroundDescription.includes("explicit user request")) throw new Error("background parameter does not document execution-mode resolution");
        const typeDescription = definition.parameters.properties.subagent_type.description;
        if (!typeDescription.includes("Use an exact listed name; unknown names fail closed")) throw new Error("type parameter omits fail-closed guidance");
        const thinkingValues = definition.parameters.properties.thinking.anyOf?.map((schema) => schema.const);
        if (JSON.stringify(thinkingValues) !== JSON.stringify(["off", "minimal", "low", "medium", "high", "xhigh"])) throw new Error("thinking schema is not the exact literal union");
        if (definition.parameters.properties.max_turns.type !== "integer") throw new Error("max_turns schema accepts fractional turns");
      }).catch((error) => { console.error(error); process.exit(1); });
    `,
    jitiFile,
    runtimeRoot,
    path.join(packageDir, "src", "config", "default-agents.ts"),
    path.join(packageDir, "src", "config", "agent-types.ts"),
    path.join(packageDir, "src", "session", "prompts.ts"),
    path.join(packageDir, "src", "tools", "agent-tool.ts"),
    path.join(packageDir, "src", "config", "custom-agents.ts"),
    profileProject,
  ], { cwd: runtimeRoot, encoding: "utf8", windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: profileRoot } });
  assert.equal(renderedCheck.status, 0, renderedCheck.stderr || renderedCheck.stdout);

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

async function assertBackgroundTasksArtifact(packageDir) {
  const config = stack.backgroundTasksPromptPatch;
  const file = path.join(packageDir, config.bundle);
  const original = fs.readFileSync(file, "utf8");
  assert.equal(backgroundTasksPatch.apply(packageDir).action, "patched");
  assert.equal(backgroundTasksPatch.verify(packageDir).ok, true);
  assert.equal(backgroundTasksPatch.apply(packageDir).action, "already-patched");

  const patched = fs.readFileSync(file, "utf8");
  assert.equal(patched.split(backgroundTasksPatch.RUNTIME_ISOLATION_SENTINEL).length - 1, 1);
  assert.doesNotMatch(patched, /^[ \t]*\/\/[#@]\s*sourceMappingURL=/m);
  const runtimeCheck = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { EventEmitter } from "node:events";
const loaded = await import(${JSON.stringify(`${pathToFileURL(file).href}?pui-runtime-isolation=${Date.now()}`)});
const registrations = () => {
  const tools = new Map(), handlers = new Map();
  const api = new Proxy({
    events: { on() {} },
    on(event, handler) { const registered = handlers.get(event) ?? []; registered.push(handler); handlers.set(event, registered); },
    registerTool(tool) { tools.set(tool.name, tool); },
  }, { get(target, property) { return property in target ? target[property] : () => {}; } });
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {}, write() {} };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  loaded.default(api, { spawnProcess });
  return { tools, handlers };
};
const first = registrations(), second = registrations();
const expected = ["bg_kill", "bg_logs", "bg_send", "bg_start", "bg_status", "bg_wait"];
if (JSON.stringify([...first.tools.keys()].sort()) !== JSON.stringify(expected) || JSON.stringify([...second.tools.keys()].sort()) !== JSON.stringify(expected)) throw new Error("background-task tool registration drift");
if (first.handlers.size !== 9 || second.handlers.size !== 9) throw new Error("background-task lifecycle registration drift");
const context = { cwd: process.cwd(), isProjectTrusted: () => true, hasUI: false, ui: { getToolsExpanded: () => false, setWidget() {}, notify() {} } };
const signal = new AbortController().signal;
await first.tools.get("bg_start").execute("pui-start", { name: "isolated-a", command: "echo ok" }, signal, () => {}, context);
const firstStatus = await first.tools.get("bg_status").execute("pui-status-a", {}, signal, () => {}, context);
const secondStatus = await second.tools.get("bg_status").execute("pui-status-b", {}, signal, () => {}, context);
if (firstStatus.details.tasks.length !== 1 || secondStatus.details.tasks.length !== 0) throw new Error("background-task runtime state crossed factory instances");`,
  ], { cwd: packageDir, encoding: "utf8", windowsHide: true });
  assert.equal(runtimeCheck.status, 0, runtimeCheck.stderr || runtimeCheck.stdout);

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

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-prompt-patches-artifact-"));
  try {
    installArtifacts(temp);
    assertSubagentsArtifact(packageDir(temp, stack.subagentsPromptPatch.packagePath), temp);
    await assertBackgroundTasksArtifact(packageDir(temp, stack.backgroundTasksPromptPatch.packagePath));
    console.log(`Published ${stack.upstream.subagents.npm}@${stack.upstream.subagents.version} and ${stack.upstream.backgroundTasks.npm}@${stack.upstream.backgroundTasks.version} prompt patch artifacts passed`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
