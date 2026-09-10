const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const coreUrl = pathToFileURL(path.join(repoRoot, "extensions", "pui-model-catalog", "core.ts")).href;

async function loadCore() {
  return import(`${coreUrl}?test=${Date.now()}-${Math.random()}`);
}

function fakePi() {
  const tools = new Map();
  return { registerTool(tool) { tools.set(tool.name, tool); }, tools };
}

function model(overrides = {}) {
  return {
    provider: "openai-codex",
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    api: "openai-codex-responses",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, tiers: [{ inputTokensAbove: 200000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }] },
    thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
    ...overrides,
  };
}

function output(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("entrypoint imports TypeBox from Pi's shipped package", () => {
  const source = fs.readFileSync(path.join(repoRoot, "extensions", "pui-model-catalog", "index.ts"), "utf8");
  assert.match(source, /from "typebox"/);
  assert.doesNotMatch(source, /@sinclair\/typebox/);
});

test("registers model_list with precise discovery guidance", async () => {
  const { registerPuiModelCatalog } = await loadCore();
  const pi = fakePi();
  registerPuiModelCatalog(pi);
  assert.deepEqual([...pi.tools.keys()], ["model_list"]);
  const tool = pi.tools.get("model_list");
  assert.match(tool.description, /currently available/i);
  assert.match(tool.description, /provider\/model id/i);
  assert.match(tool.description, /fuzzy/i);
  assert.match(tool.description, /matches[\s\S]*rank[\s\S]*score/i);
  assert.match(tool.parameters.properties.query.description, /rank/i);
});

test("groups sorted available models and reports complete selection metadata", async () => {
  const { registerPuiModelCatalog } = await loadCore();
  const pi = fakePi();
  registerPuiModelCatalog(pi);
  const models = [
    model(),
    model({ provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", api: "anthropic-messages", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 64000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, thinkingLevelMap: undefined }),
  ];
  const ctx = { modelRegistry: { getAvailable: () => models, getProviderDisplayName: (provider) => provider === "anthropic" ? "Anthropic" : "OpenAI Codex" } };

  const result = output(await pi.tools.get("model_list").execute("call", {}, undefined, undefined, ctx));
  assert.equal(result.totalModels, 2);
  assert.deepEqual(result.providers.map((provider) => provider.id), ["anthropic", "openai-codex"]);
  assert.equal(result.providers[1].displayName, "OpenAI Codex");
  assert.deepEqual(result.providers[1].models[0], {
    provider: "openai-codex",
    id: "gpt-6-astra",
    providerModelId: "openai-codex/gpt-6-astra",
    name: "GPT-6 Astra",
    api: "openai-codex-responses",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    capabilities: { input: ["text", "image"], reasoning: true },
    costUsdPerMillionTokens: {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 200000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }],
    },
    reasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
  });
  assert.deepEqual(result.providers[0].models[0].reasoningEfforts, ["off"]);
});

test("optional fuzzy query matches provider, id, full id, and display name tokens", async () => {
  const { registerPuiModelCatalog } = await loadCore();
  const pi = fakePi();
  registerPuiModelCatalog(pi);
  const models = [model(), model({ provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" })];
  const ctx = { modelRegistry: { getAvailable: () => models, getProviderDisplayName: (provider) => provider } };
  const tool = pi.tools.get("model_list");

  for (const query of ["gpt 6", "codex astra", "openai-codex/gpt-6-astra", "GPT-6 Astra"]) {
    const result = output(await tool.execute("call", { query }, undefined, undefined, ctx));
    assert.equal(result.totalModels, 1, query);
    assert.equal(result.providers[0].models[0].id, "gpt-6-astra", query);
    assert.equal(result.query, query);
  }
  assert.equal(output(await tool.execute("call", { query: "unknown" }, undefined, undefined, ctx)).totalModels, 0);
});

test("fuzzy output preserves the global resolver rank across provider groups", async () => {
  const { registerPuiModelCatalog } = await loadCore();
  const pi = fakePi();
  registerPuiModelCatalog(pi);
  const models = [
    model({ provider: "a", id: "gpt-x" }),
    model({ provider: "b", id: "gpt-xx" }),
    model({ provider: "a", id: "gpt-xxx" }),
  ];
  const ctx = { modelRegistry: { getAvailable: () => models, getProviderDisplayName: (provider) => provider } };

  const result = output(await pi.tools.get("model_list").execute("call", { query: "gpt" }, undefined, undefined, ctx));
  assert.deepEqual(
    result.matches.map((entry) => entry.providerModelId),
    ["a/gpt-x", "b/gpt-xx", "a/gpt-xxx"],
  );
  assert.deepEqual(result.matches.map((entry) => entry.rank), [1, 2, 3]);
  assert.equal(typeof result.matches[0].score, "number");
  assert.equal(result.matches[0].match, "id");
});

test("rejects an empty padded query rather than silently listing everything", async () => {
  const { registerPuiModelCatalog } = await loadCore();
  const pi = fakePi();
  registerPuiModelCatalog(pi);
  const ctx = { modelRegistry: { getAvailable: () => [], getProviderDisplayName: (provider) => provider } };
  await assert.rejects(() => pi.tools.get("model_list").execute("call", { query: "   " }, undefined, undefined, ctx), /query/i);
});
