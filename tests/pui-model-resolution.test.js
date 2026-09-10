const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const resolverUrl = pathToFileURL(path.join(repoRoot, "extensions", "pui-model-catalog", "resolver.ts")).href;
async function loadResolver() { return import(`${resolverUrl}?test=${Date.now()}-${Math.random()}`); }
function model(provider, id, name = id, extra = {}) { return { provider, id, name, reasoning: true, ...extra }; }

const models = [
  model("openai-codex", "gpt-6-astra", "GPT-6 Astra"),
  model("openai", "gpt-6-astra", "GPT-6 Astra API"),
  model("openai-codex", "gpt-6-astra-20260901", "GPT-6 Astra 2026-09-01"),
  model("anthropic", "claude-sonnet-5", "Claude Sonnet 5"),
];

test("resolver follows Pi-compatible exact identity and rejects ambiguous bare IDs", async () => {
  const { createPuiModelResolver } = await loadResolver();
  const resolver = createPuiModelResolver();
  assert.equal(resolver.version, 1);
  assert.equal(resolver.resolve(" openai-codex/gpt-6-astra ", models).model, models[0]);
  const ambiguous = resolver.resolve("gpt-6-astra", models);
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.matches.map((entry) => entry.providerModelId), ["openai-codex/gpt-6-astra", "openai/gpt-6-astra"]);
  const colonId = model("openrouter", "vendor/model:free");
  assert.equal(resolver.resolve("openrouter/vendor/model:free", [...models, colonId]).model, colonId, "colons inside model IDs remain part of the exact identity");
});

test("resolver adds deterministic normalized-token matching and alias preference", async () => {
  const { createPuiModelResolver } = await loadResolver();
  const resolver = createPuiModelResolver();
  assert.equal(resolver.resolve("gpt 6 astra", models.filter((entry) => entry.provider !== "openai")).model, models[0], "stable alias wins over dated variant");
  assert.equal(resolver.resolve("codex gpt 6", models).model, models[0]);
  assert.equal(resolver.resolve("Claude Sonnet", models).model, models[3]);
  assert.equal(resolver.resolve("missing", models).status, "not-found");
  assert.equal(resolver.resolve("   ", models).status, "invalid");
});

test("rank returns every deterministic fuzzy candidate while resolve requires a unique best score", async () => {
  const { createPuiModelResolver } = await loadResolver();
  const resolver = createPuiModelResolver();
  const tied = [model("a", "gpt-6-one"), model("b", "gpt-6-two")];
  const ranked = resolver.rank("gpt 6", tied);
  assert.deepEqual(ranked.map((entry) => entry.providerModelId), ["a/gpt-6-one", "b/gpt-6-two"]);
  assert.equal(resolver.resolve("gpt 6", tied).status, "ambiguous");
});

test("fuzzy ranking prefers stable aliases and then the newest dated version", async () => {
  const { createPuiModelResolver } = await loadResolver();
  const resolver = createPuiModelResolver();
  const longAlias = model("p", "model-production-stable-alias");
  const dated2024 = model("p", "model-20240101");
  const dated2025 = model("p", "model-20250101");

  assert.equal(resolver.resolve("model", [dated2025, longAlias]).model, longAlias);
  assert.equal(resolver.resolve("model", [dated2024, dated2025]).model, dated2025);
  assert.deepEqual(
    resolver.rank("model", [dated2024, dated2025]).map((entry) => entry.providerModelId),
    ["p/model-20250101", "p/model-20240101"],
  );
});

test("reasoning efforts use Pi 0.84.3 support semantics", async () => {
  const { createPuiModelResolver } = await loadResolver();
  const resolver = createPuiModelResolver();
  assert.deepEqual(resolver.getSupportedThinkingLevels(model("p", "plain", "plain", { reasoning: false })), ["off"]);
  assert.deepEqual(resolver.getSupportedThinkingLevels(model("p", "reason", "reason", { thinkingLevelMap: { off: null, xhigh: "xhigh", max: null } })), ["minimal", "low", "medium", "high", "xhigh"]);
});

test("global installation is versioned, idempotent, and fails closed on collision", async () => {
  const { installPuiModelResolver, PUI_MODEL_RESOLVER_SYMBOL } = await loadResolver();
  const host = {};
  const first = installPuiModelResolver(host);
  assert.equal(installPuiModelResolver(host), first);
  host[PUI_MODEL_RESOLVER_SYMBOL] = { version: 2 };
  assert.throws(() => installPuiModelResolver(host), /version|collision/i);
});
