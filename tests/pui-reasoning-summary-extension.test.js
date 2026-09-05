const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const coreUrl = pathToFileURL(path.join(repoRoot, "extensions", "pui-reasoning-summary", "core.ts")).href;

async function loadCore() {
  return import(`${coreUrl}?test=${Date.now()}-${Math.random()}`);
}

function fakePi() {
  const handlers = new Map();
  return {
    on(name, handler) { handlers.set(name, handler); },
    handler(name) { return handlers.get(name); },
  };
}

function writeConfig(t, value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-reasoning-summary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "reasoning-summaries.json");
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

const baseConfig = {
  schemaVersion: 1,
  modelModes: {
    "gpt-5.6-sol": "detailed",
    "openai-codex/gpt-5.6-sol": "concise",
    "gpt-5.6-luna": "none",
    "gpt-5.6-terra": "auto",
  },
};

for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"]) {
  test(`${api} applies the configured summary mode`, async (t) => {
    const { registerPuiReasoningSummary } = await loadCore();
    const configPath = writeConfig(t, baseConfig);
    const pi = fakePi();
    registerPuiReasoningSummary(pi, { configPath });
    const payload = { model: "gpt-5.6-sol", reasoning: { effort: "high", summary: "auto" }, input: [] };
    const result = await pi.handler("before_provider_request")({ payload }, {
      model: { api, provider: "openai-codex", id: "gpt-5.6-sol" },
    });
    assert.equal(result.model, "gpt-5.6-sol");
    assert.equal(result.input, payload.input);
    assert.deepEqual(result.reasoning, { effort: "high", summary: "concise" });
    assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" });
  });
}

test("qualified provider/model identity takes precedence over a bare model id", async (t) => {
  const { registerPuiReasoningSummary } = await loadCore();
  const pi = fakePi();
  registerPuiReasoningSummary(pi, { configPath: writeConfig(t, baseConfig) });
  const result = await pi.handler("before_provider_request")({ payload: { model: "gpt-5.6-sol", reasoning: { effort: "medium" } } }, {
    model: { api: "openai-responses", provider: "openai-codex", id: "gpt-5.6-sol" },
  });
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.reasoning.summary, "concise");
});

test("bare model ids match Azure deployment identities", async (t) => {
  const { registerPuiReasoningSummary } = await loadCore();
  const pi = fakePi();
  registerPuiReasoningSummary(pi, { configPath: writeConfig(t, baseConfig) });
  const result = await pi.handler("before_provider_request")({ payload: { model: "gpt-5.6-sol", reasoning: { effort: "high" } } }, {
    model: { api: "azure-openai-responses", provider: "azure", id: "gpt-5.6-sol" },
  });
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.reasoning.summary, "detailed");
});

test("auto sets the explicit provider mode", async (t) => {
  const { registerPuiReasoningSummary } = await loadCore();
  const pi = fakePi();
  registerPuiReasoningSummary(pi, { configPath: writeConfig(t, baseConfig) });
  const result = await pi.handler("before_provider_request")({ payload: { model: "gpt-5.6-terra", reasoning: { effort: "medium", summary: "concise" } } }, {
    model: { api: "openai-responses", provider: "openai", id: "gpt-5.6-terra" },
  });
  assert.equal(result.model, "gpt-5.6-terra");
  assert.equal(result.reasoning.summary, "auto");
});

test("none removes summary while preserving active reasoning", async (t) => {
  const { registerPuiReasoningSummary } = await loadCore();
  const pi = fakePi();
  registerPuiReasoningSummary(pi, { configPath: writeConfig(t, baseConfig) });
  const result = await pi.handler("before_provider_request")({ payload: { model: "gpt-5.6-luna", reasoning: { effort: "high", summary: "auto" } } }, {
    model: { api: "openai-responses", provider: "openai", id: "gpt-5.6-luna" },
  });
  assert.equal(result.model, "gpt-5.6-luna");
  assert.deepEqual(result.reasoning, { effort: "high" });
});

test("unsupported APIs and unconfigured models are unchanged", async (t) => {
  const { registerPuiReasoningSummary } = await loadCore();
  const pi = fakePi();
  registerPuiReasoningSummary(pi, { configPath: writeConfig(t, baseConfig) });
  for (const model of [
    { api: "anthropic-messages", provider: "anthropic", id: "gpt-5.6-sol" },
    { api: "openai-responses", provider: "openai", id: "other-model" },
  ]) {
    const payload = { reasoning: { effort: "high", summary: "auto" } };
    assert.equal(await pi.handler("before_provider_request")({ payload }, { model }), undefined);
    assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" });
  }
});

test("reasoning-off requests never gain a reasoning object or summary", async (t) => {
  const { registerPuiReasoningSummary } = await loadCore();
  const pi = fakePi();
  registerPuiReasoningSummary(pi, { configPath: writeConfig(t, baseConfig) });
  for (const payload of [{ input: [] }, { reasoning: {} }, { reasoning: { effort: "none" } }]) {
    const original = structuredClone(payload);
    assert.equal(await pi.handler("before_provider_request")({ payload }, {
      model: { api: "openai-responses", provider: "openai", id: "gpt-5.6-sol" },
    }), undefined);
    assert.deepEqual(payload, original);
  }
});

test("invalid or missing configuration fails closed without changing payloads", async (t) => {
  const { registerPuiReasoningSummary } = await loadCore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-reasoning-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of [["invalid.json", "{"], ["bad-mode.json", '{"schemaVersion":1,"modelModes":{"gpt-5.6-sol":"verbose"}}'], ["missing.json", null]]) {
    const configPath = path.join(root, name);
    if (content !== null) fs.writeFileSync(configPath, content);
    const pi = fakePi();
    registerPuiReasoningSummary(pi, { configPath });
    const payload = { reasoning: { effort: "high", summary: "auto" } };
    assert.equal(await pi.handler("before_provider_request")({ payload }, {
      model: { api: "openai-responses", provider: "openai", id: "gpt-5.6-sol" },
    }), undefined);
    assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" });
  }
});
