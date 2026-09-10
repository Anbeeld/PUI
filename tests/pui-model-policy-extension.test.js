const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const coreUrl = pathToFileURL(path.join(repoRoot, "extensions", "pui-model-policy", "core.ts")).href;

async function loadCore() {
  return import(`${coreUrl}?test=${Date.now()}-${Math.random()}`);
}

function configFile(t, value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-model-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "model-policy.json");
  if (value !== undefined) fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function validConfig(tools = { deny: ["subagent"] }) {
  return {
    schemaVersion: 1,
    providers: {
      "openai-codex": {
        models: [{ id: "gpt-x", tools }],
      },
    },
  };
}

function fakePi(initial = ["read", "bash", "subagent", "session_start"]) {
  let active = [...initial];
  const handlers = new Map();
  return {
    on(name, handler) {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    },
    getActiveTools: () => [...active],
    getAllTools: () => ["read", "bash", "subagent", "session_start", "late_tool"].map((name) => ({ name })),
    setActiveTools(names) { active = [...names]; },
    active: () => [...active],
    async emit(name, event, context) {
      let result;
      for (const handler of handlers.get(name) || []) result = await handler(event, context);
      return result;
    },
  };
}

const restricted = { model: { provider: "openai-codex", id: "gpt-x" }, ui: { notify() {} } };
const unrestricted = { model: { provider: "openai-codex", id: "gpt-y" }, ui: { notify() {} } };

test("parses provider-grouped model capability policies strictly", async () => {
  const { parseConfig } = await loadCore();
  assert.deepEqual(parseConfig(validConfig()), validConfig());
  assert.deepEqual(parseConfig(validConfig({ allow: ["read", "bash"] })), validConfig({ allow: ["read", "bash"] }));
  for (const value of [
    {},
    { schemaVersion: 2, providers: {} },
    { schemaVersion: 1, providers: [] },
    { schemaVersion: 1, providers: { " openai": { models: [] } } },
    { schemaVersion: 1, providers: { openai: { models: [{ id: "x", tools: { allow: [], deny: [] } }] } } },
    { schemaVersion: 1, providers: { openai: { models: [{ id: "x", tools: { deny: [" bad"] } }] } } },
    { schemaVersion: 1, providers: { openai: { models: [{ id: "x" }, { id: "x" }] } } },
  ]) assert.equal(parseConfig(value), undefined, JSON.stringify(value));
});

test("deny policy removes tool definitions and restores only policy-removed tools", async (t) => {
  const { registerPuiModelPolicy } = await loadCore();
  const pi = fakePi(["read", "subagent"]); // bash is user-disabled and must remain disabled.
  registerPuiModelPolicy(pi, { configPath: configFile(t, validConfig()) });

  await pi.emit("session_start", {}, restricted);
  assert.deepEqual(pi.active(), ["read"]);

  await pi.emit("model_select", { model: unrestricted.model }, unrestricted);
  assert.deepEqual(pi.active(), ["read", "subagent"]);
});

test("allow policy retains only currently active listed tools", async (t) => {
  const { registerPuiModelPolicy } = await loadCore();
  const pi = fakePi();
  registerPuiModelPolicy(pi, { configPath: configFile(t, validConfig({ allow: ["read", "bash"] })) });
  await pi.emit("session_start", {}, restricted);
  assert.deepEqual(pi.active(), ["read", "bash"]);
});

test("tool-call guard blocks prohibited and stale calls but permits other models", async (t) => {
  const { registerPuiModelPolicy } = await loadCore();
  const pi = fakePi();
  registerPuiModelPolicy(pi, { configPath: configFile(t, validConfig()) });

  const blocked = await pi.emit("tool_call", { toolName: "subagent" }, restricted);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /model policy/i);
  assert.equal(await pi.emit("tool_call", { toolName: "read" }, restricted), undefined);
  assert.equal(await pi.emit("tool_call", { toolName: "subagent" }, unrestricted), undefined);
});

test("reapplies policy after tool results to hide dynamically activated denied tools", async (t) => {
  const { registerPuiModelPolicy } = await loadCore();
  const pi = fakePi();
  registerPuiModelPolicy(pi, { configPath: configFile(t, validConfig({ deny: ["late_tool"] })) });
  await pi.emit("session_start", {}, restricted);
  pi.setActiveTools([...pi.active(), "late_tool"]);
  await pi.emit("tool_result", {}, restricted);
  assert.equal(pi.active().includes("late_tool"), false);
});

test("invalid policy fails closed while a missing policy is unrestricted", async (t) => {
  const { registerPuiModelPolicy } = await loadCore();
  const invalidPi = fakePi();
  const invalid = configFile(t, { schemaVersion: 1, providers: [] });
  registerPuiModelPolicy(invalidPi, { configPath: invalid });
  await invalidPi.emit("session_start", {}, restricted);
  assert.deepEqual(invalidPi.active(), []);
  assert.equal((await invalidPi.emit("tool_call", { toolName: "read" }, restricted)).block, true);

  const missingPi = fakePi();
  registerPuiModelPolicy(missingPi, { configPath: configFile(t, undefined) });
  await missingPi.emit("session_start", {}, restricted);
  assert.deepEqual(missingPi.active(), ["read", "bash", "subagent", "session_start"]);
});

test("entrypoint identifies the PUI model-policy extension", () => {
  const source = fs.readFileSync(path.join(repoRoot, "extensions", "pui-model-policy", "index.ts"), "utf8");
  assert.match(source, /registerPuiModelPolicy/);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "extensions", "pui-model-policy", "package.json"), "utf8"));
  assert.equal(pkg.name, "pui-model-policy");
});
