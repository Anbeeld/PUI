const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const coreUrl = pathToFileURL(path.join(repoRoot, "extensions", "pui-session-communication", "core.ts")).href;

async function loadCore() {
  return import(`${coreUrl}?test=${Date.now()}-${Math.random()}`);
}

function fakePi() {
  const tools = new Map();
  return {
    registerTool(tool) { tools.set(tool.name, tool); },
    tools,
  };
}

function context(overrides = {}) {
  return {
    cwd: "C:/work/source",
    model: { provider: "openai-codex", id: "gpt-5.6-luna" },
    thinkingLevel: "high",
    sessionManager: { getSessionId: () => "source-session" },
    ...overrides,
  };
}

function text(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("entrypoint imports the TypeBox package shipped with Pi", () => {
  const source = require("node:fs").readFileSync(path.join(repoRoot, "extensions", "pui-session-communication", "index.ts"), "utf8");
  assert.match(source, /from "typebox"/);
  assert.doesNotMatch(source, /@sinclair\/typebox/);
});

test("registers the five Pi Web collaboration tools", async () => {
  const { registerPuiSessionCommunication } = await loadCore();
  const pi = fakePi();
  registerPuiSessionCommunication(pi, { broker: { version: 1 } });
  assert.deepEqual([...pi.tools.keys()], [
    "session_list",
    "session_get",
    "session_send",
    "session_start",
    "session_abort",
  ]);
});

test("does not register tools without the exact Pi Web broker", async () => {
  const { registerPuiSessionCommunication } = await loadCore();
  for (const broker of [undefined, {}, { version: 2 }]) {
    const pi = fakePi();
    registerPuiSessionCommunication(pi, { broker });
    assert.equal(pi.tools.size, 0);
  }
});

test("forwards server-derived caller identity and omitted overrides", async () => {
  const { registerPuiSessionCommunication } = await loadCore();
  const calls = [];
  const broker = {
    version: 1,
    list: async (request) => (calls.push(["list", request]), { projects: {} }),
    get: async (request) => (calls.push(["get", request]), { id: request.id }),
    send: async (request) => (calls.push(["send", request]), { accepted: true }),
    start: async (request) => (calls.push(["start", request]), { accepted: true, id: "new" }),
    abort: async (request) => (calls.push(["abort", request]), { aborted: true }),
  };
  const pi = fakePi();
  registerPuiSessionCommunication(pi, { broker });
  const ctx = context();

  text(await pi.tools.get("session_list").execute("call-list", {}, undefined, undefined, ctx));
  text(await pi.tools.get("session_get").execute("call-get", { id: "target" }, undefined, undefined, ctx));
  text(await pi.tools.get("session_send").execute("call-send", { id: "target", message: "Investigate" }, undefined, undefined, ctx));
  text(await pi.tools.get("session_start").execute("call-start", { project: "C:/work/target", message: "Implement" }, undefined, undefined, ctx));
  text(await pi.tools.get("session_abort").execute("call-abort", { id: "target" }, undefined, undefined, ctx));

  assert.deepEqual(calls[2], ["send", {
    sourceSessionId: "source-session",
    operationId: "source-session:call-send",
    targetSessionId: "target",
    message: "Investigate",
    delivery: "steer",
  }]);
  assert.deepEqual(calls[3], ["start", {
    sourceSessionId: "source-session",
    operationId: "source-session:call-start",
    project: "C:/work/target",
    message: "Implement",
    inheritModel: { provider: "openai-codex", id: "gpt-5.6-luna" },
    inheritEffort: "high",
  }]);
  assert.equal("model" in calls[2][1], false);
  assert.equal("effort" in calls[2][1], false);
  assert.equal("model" in calls[3][1], false);
  assert.equal("effort" in calls[3][1], false);
});

test("forwards explicit fuzzy model and effort overrides without rewriting them", async () => {
  const { registerPuiSessionCommunication } = await loadCore();
  const calls = [];
  const broker = {
    version: 1,
    send: async (request) => (calls.push(request), { accepted: true }),
    start: async (request) => (calls.push(request), { accepted: true, id: "new" }),
  };
  const pi = fakePi();
  registerPuiSessionCommunication(pi, { broker });
  const ctx = context();

  await pi.tools.get("session_send").execute("send", { id: "target", message: "Review", delivery: "follow_up", model: "luna", effort: "max" }, undefined, undefined, ctx);
  await pi.tools.get("session_start").execute("start", { project: "C:/work/target", message: "Build", model: "haiku", effort: "xhigh" }, undefined, undefined, ctx);

  assert.equal(calls[0].model, "luna");
  assert.equal(calls[0].effort, "max");
  assert.equal(calls[0].delivery, "follow_up");
  assert.equal(calls[1].model, "haiku");
  assert.equal(calls[1].effort, "xhigh");
});

test("session_get defines its JSONL path field and null case precisely", async () => {
  const { registerPuiSessionCommunication } = await loadCore();
  const pi = fakePi();
  registerPuiSessionCommunication(pi, { broker: { version: 1 } });
  const tool = pi.tools.get("session_get");

  assert.match(tool.promptSnippet, /persisted JSONL session log/i);
  assert.match(tool.description, /sessionLogPath/);
  assert.doesNotMatch(tool.description, /sessionJsonlPath/);
  assert.match(tool.description, /absolute filesystem path/i);
  assert.match(tool.description, /not (?:read|injected)/i);
  assert.match(tool.description, /persisted is false[\s\S]*null/i);
});

test("tool descriptions define result state and peer-run cost boundaries", async () => {
  const { registerPuiSessionCommunication } = await loadCore();
  const pi = fakePi();
  registerPuiSessionCommunication(pi, { broker: { version: 1 } });

  assert.match(pi.tools.get("session_list").description, /returns[\s\S]*projects[\s\S]*invalid[\s\S]*fail/i);
  assert.match(pi.tools.get("session_get").description, /unknown[\s\S]*non-unique[\s\S]*fail/i);
  assert.match(pi.tools.get("session_send").description, /accepted[\s\S]*queued[\s\S]*not[\s\S]*completion[\s\S]*rejects[\s\S]*current session[\s\S]*unknown target[\s\S]*unavailable model/i);
  assert.match(pi.tools.get("session_start").description, /accepted[\s\S]*completion notification[\s\S]*do not poll[\s\S]*rejects[\s\S]*nonexistent project[\s\S]*unavailable model/i);
  assert.match(pi.tools.get("session_abort").description, /aborted[\s\S]*state[\s\S]*rejects[\s\S]*same-session/i);
  for (const name of ["session_send", "session_start"]) {
    assert.match(pi.tools.get(name).description, /loops[\s\S]*fan-out[\s\S]*model cost/i);
  }
});

test("send and start require an explicit current-user request", async () => {
  const { registerPuiSessionCommunication } = await loadCore();
  const pi = fakePi();
  registerPuiSessionCommunication(pi, { broker: { version: 1 } });

  const send = pi.tools.get("session_send");
  assert.match(send.promptSnippet, /user-requested/i);
  assert.match(send.description, /use session_send only when the current user explicitly requests sending task input to another session/i);
  assert.match(send.description, /do not infer permission[\s\S]*task complexity[\s\S]*parallelism[\s\S]*available target[\s\S]*peer input/i);

  const start = pi.tools.get("session_start");
  assert.match(start.promptSnippet, /user-requested/i);
  assert.match(start.description, /use session_start only when the current user explicitly requests starting a new session/i);
  assert.match(start.description, /do not infer permission[\s\S]*task complexity[\s\S]*parallelism[\s\S]*available project[\s\S]*peer input/i);
});

test("tool guidance forbids inferred model and effort overrides", async () => {
  const { registerPuiSessionCommunication } = await loadCore();
  const pi = fakePi();
  registerPuiSessionCommunication(pi, { broker: { version: 1 } });
  for (const name of ["session_send", "session_start"]) {
    const tool = pi.tools.get(name);
    assert.match(tool.description, /only when the user explicitly requested/i);
    assert.match(tool.description, /fuzzy/i);
    assert.match(tool.description, /nearest lower/i);
  }
});
