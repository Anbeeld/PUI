#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { apply, remove, resolveRuntime, verify } = require("../lib/pui-pi-8782-backport.js");

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

function runBehavior(piWebRoot) {
  return spawnSync(process.execPath, [__filename, "--behavior", piWebRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
}

function responseFor(message) {
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => message,
  };
}

function fixtureMessage(role, content, extra = {}) {
  return {
    role,
    content,
    provider: "fixture",
    model: "fixture-model",
    api: "fixture",
    timestamp: Date.now(),
    ...extra,
  };
}

async function runBehavioralCases(piWebRoot) {
  const runtime = resolveRuntime({ piWebRoot });
  const { Agent } = await import(pathToFileURL(path.join(runtime.agentCoreRoot, "dist", "agent.js")).href);
  const { AgentSession } = await import(pathToFileURL(runtime.targets.agentSession.file).href);
  const { buildSessionContext } = await import(pathToFileURL(path.join(runtime.codingAgentRoot, "dist", "core", "session-manager.js")).href);

  async function runCase({ terminate, queueSteering }) {
    const largeText = "L".repeat(2400);
    const tool = {
      name: "large_result",
      description: "Return a large fixture result",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({
        content: [{ type: "text", text: largeText }],
        details: {},
        terminate,
      }),
    };
    const model = {
      id: "fixture-model",
      name: "Fixture model",
      api: "fixture",
      provider: "fixture",
      baseUrl: "http://fixture.invalid",
      contextWindow: 300,
      maxTokens: 100,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const firstResponse = fixtureMessage("assistant", [{ type: "toolCall", id: "call-1", name: "large_result", arguments: {} }], {
      stopReason: "toolUse",
      usage: { input: 1, output: 1, totalTokens: 2 },
    });
    const secondResponse = fixtureMessage("assistant", [{ type: "text", text: "continued after compaction" }], {
      stopReason: "stop",
      usage: { input: 1, output: 1, totalTokens: 2 },
    });
    const responses = terminate ? [firstResponse] : [firstResponse, secondResponse];
    const providerRequests = [];
    const timeline = [];
    let responseIndex = 0;
    let compactionCalls = 0;
    let steeringQueued = false;
    const agent = new Agent({
      initialState: {
        systemPrompt: "fixture system",
        messages: [],
        tools: [tool],
        model,
        thinkingLevel: "off",
      },
      convertToLlm: async (messages) => messages,
      streamFn: async (_requestModel, context) => {
        timeline.push("provider");
        providerRequests.push({ ...context, messages: context.messages.slice() });
        return responseFor(responses[responseIndex++]);
      },
    });
    const eventTypes = [];
    agent.subscribe((event) => {
      eventTypes.push(event.type);
      timeline.push(`event:${event.type}`);
    });

    let entries = [
      {
        type: "message",
        id: "user-1",
        parentId: undefined,
        message: fixtureMessage("user", [{ type: "text", text: "start" }]),
      },
    ];
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      message: firstResponse,
    };
    const toolEntry = {
      type: "message",
      id: "tool-1",
      parentId: "assistant-1",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "large_result",
        content: [{ type: "text", text: largeText }],
        details: {},
        isError: false,
        timestamp: Date.now(),
      },
    };
    entries.push(assistantEntry, toolEntry);

    const sessionManager = {
      getBranch: () => entries.slice(),
      appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage) {
        entries.push({
          type: "compaction",
          id: "compaction-1",
          parentId: entries.at(-1)?.id,
          summary,
          firstKeptEntryId,
          tokensBefore,
          details,
          fromHook: fromExtension,
          usage,
        });
      },
      getEntries: () => entries.slice(),
      buildSessionContext: () => buildSessionContext(entries),
    };
    const fakeSession = {
      agent,
      model,
      sessionManager,
      settingsManager: {
        getCompactionSettings: () => ({ enabled: true, reserveTokens: 0, keepRecentTokens: 604 }),
      },
      _systemPromptOverride: undefined,
      _baseSystemPrompt: "fixture system",
      _extensionRunner: {
        hasHandlers: () => false,
        emit: async () => {},
      },
      _emit: (event) => timeline.push(`session:${event.type}`),
      _emitSessionCompactFailed: async () => {},
      _getSummarizationRequestAuth: async () => ({ model }),
      _runDefaultCompaction: async (preparation) => {
        compactionCalls += 1;
        assert.equal(preparation.firstKeptEntryId, "assistant-1");
        if (queueSteering && !steeringQueued) {
          steeringQueued = true;
          agent.steer(fixtureMessage("user", [{ type: "text", text: "steering during compaction" }]));
        }
        return {
          summary: "retained history",
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: undefined,
          details: {},
        };
      },
    };
    fakeSession._compactBeforeNextAssistantResponse = AgentSession.prototype._compactBeforeNextAssistantResponse;
    fakeSession._runAutoCompaction = AgentSession.prototype._runAutoCompaction;
    AgentSession.prototype._installAgentNextTurnRefresh.call(fakeSession);

    await agent.prompt("start");
    return { agent, eventTypes, providerRequests, timeline, compactionCalls, largeText };
  }

  const continued = await runCase({ terminate: false, queueSteering: true });
  assert.equal(continued.providerRequests.length, 2, "the same run must issue a resumed provider request");
  assert.equal(continued.compactionCalls, 1, "threshold compaction must run between turns");
  assert.equal(continued.eventTypes.filter((event) => event === "agent_start").length, 1, "compaction must not start a second agent run");
  const compactionEnd = continued.timeline.indexOf("session:compaction_end");
  const secondProvider = continued.timeline.lastIndexOf("provider");
  assert.ok(compactionEnd !== -1 && compactionEnd < secondProvider, "compaction must complete before the next provider request");
  const resumedMessages = continued.providerRequests[1].messages;
  assert.equal(resumedMessages.filter((message) => message.role === "toolResult").length, 1, "the resumed context must retain the completed tool result");
  assert.equal(resumedMessages.find((message) => message.role === "toolResult").content[0].text, continued.largeText);
  const resumedUsers = resumedMessages.filter((message) => message.role === "user");
  assert.equal(resumedUsers.length, 1, "the resumed request must not receive a synthetic continuation user message");
  assert.equal(resumedUsers[0].content[0].text, "steering during compaction", "steering queued during compaction must reach the resumed request");
  assert.equal(resumedMessages.filter((message) => message.role === "user").some((message) => message.content[0].text === "continue"), false, "no synthetic user continuation may be introduced");

  const terminating = await runCase({ terminate: true, queueSteering: false });
  assert.equal(terminating.providerRequests.length, 1, "a terminating tool must not create another provider request");
  assert.equal(terminating.compactionCalls, 0, "a terminating tool must not trigger between-turn compaction");
  assert.equal(terminating.eventTypes.filter((event) => event === "agent_start").length, 1);
}

function runArtifactVerification() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-pi-8782-artifact-"));
  try {
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ private: true }), "utf8");
    const npmArgs = [
      "install",
      "--prefix",
      temp,
      "--install-strategy=nested",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      "--no-audit",
      "--no-fund",
      `${stack.upstream.gui.npm}@${stack.upstream.gui.version}`,
    ];
    const [npmExecutable, ...npmCommandArgs] = npmCommand(npmArgs);
    const install = spawnSync(npmExecutable, npmCommandArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
      shell: npmExecutable === "npm.cmd",
    });
    if (install.error) throw install.error;
    if (install.status !== 0) throw new Error(`npm install failed with exit ${install.status}`);
    const piWebRoot = path.join(temp, "node_modules", "@agegr", "pi-web");
    const runtime = resolveRuntime({ piWebRoot });
    const originals = Object.fromEntries(Object.entries(runtime.targets).map(([name, target]) => [name, fs.readFileSync(target.file, "utf8")]));
    const standaloneBundle = path.join(runtime.codingAgentRoot, "dist", "bundle", "cli.js");
    if (!fs.existsSync(standaloneBundle)) throw new Error(`Standalone Pi bundle was not found: ${standaloneBundle}`);
    const standaloneOriginal = fs.readFileSync(standaloneBundle);
    const applied = apply({ repoRoot, piWebRoot });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.action, "patched");
    assert.equal(apply({ repoRoot, piWebRoot }).action, "already-patched");
    assert.equal(verify({ repoRoot, piWebRoot }).ok, true);
    assert.deepEqual(fs.readFileSync(standaloneBundle), standaloneOriginal, "standalone pi bundle must remain stock");
    for (const target of Object.values(runtime.targets)) {
      const syntax = spawnSync(process.execPath, ["--check", target.file], { encoding: "utf8", windowsHide: true });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
    const behavior = runBehavior(piWebRoot);
    if (behavior.error) throw behavior.error;
    assert.equal(behavior.status, 0, "behavioral runtime verifier failed");
    assert.equal(remove(piWebRoot).action, "removed");
    for (const [name, target] of Object.entries(runtime.targets)) assert.equal(fs.readFileSync(target.file, "utf8"), originals[name]);
    assert.equal(verify({ repoRoot, piWebRoot }).reason, "manifest-missing");
    console.log(`Pi Web ${stack.upstream.gui.version} / Pi ${stack.upstream.agentRuntime.version} #8782 backport artifact and behavior checks passed`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function main(argv) {
  if (argv[0] === "--behavior") {
    await runBehavioralCases(argv[1]);
    return;
  }
  runArtifactVerification();
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
