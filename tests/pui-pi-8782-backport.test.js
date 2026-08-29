const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

const AGENT_LOOP_PREIMAGE = String.raw`    let firstTurn = true;
    // Check for steering messages at start (user may have typed while waiting)
    let pendingMessages = (await config.getSteeringMessages?.()) || [];
    // Outer loop: continues when queued follow-up messages arrive after agent would stop
    while (true) {
        let hasMoreToolCalls = true;
        // Inner loop: process tool calls and steering messages
        while (hasMoreToolCalls || pendingMessages.length > 0) {
            if (!firstTurn) {
                await emit({ type: "turn_start" });
            }
            else {
                firstTurn = false;
            }
            // Process pending messages (inject before next assistant response)
            if (pendingMessages.length > 0) {
                for (const message of pendingMessages) {
                    await emit({ type: "message_start", message });
                    await emit({ type: "message_end", message });
                    currentContext.messages.push(message);
                    newMessages.push(message);
                }
                pendingMessages = [];
            }
            // Stream assistant response
            const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
            newMessages.push(message);
            if (message.stopReason === "error" || message.stopReason === "aborted") {
                await emit({ type: "turn_end", message, toolResults: [] });
                await emit({ type: "agent_end", messages: newMessages });
                return;
            }
            // Check for tool calls
            const toolCalls = message.content.filter((c) => c.type === "toolCall");
            const toolResults = [];
            hasMoreToolCalls = false;
            if (toolCalls.length > 0) {
                // A "length" stop means the output was cut off by the token limit, so
                // every tool call in the message may carry truncated arguments. Fail
                // them all instead of executing potentially borked calls.
                const executedToolBatch = message.stopReason === "length"
                    ? await failToolCallsFromTruncatedMessage(toolCalls, emit)
                    : await executeToolCalls(currentContext, message, config, signal, emit);
                toolResults.push(...executedToolBatch.messages);
                hasMoreToolCalls = !executedToolBatch.terminate;
                for (const result of toolResults) {
                    currentContext.messages.push(result);
                    newMessages.push(result);
                }
            }
            await emit({ type: "turn_end", message, toolResults });
            const nextTurnContext = {
                message,
                toolResults,
                context: currentContext,
                newMessages,
            };
            const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
            if (nextTurnSnapshot) {
                currentContext = nextTurnSnapshot.context ?? currentContext;
                config = {
                    ...config,
                    model: nextTurnSnapshot.model ?? config.model,
                    reasoning: nextTurnSnapshot.thinkingLevel === undefined
                        ? config.reasoning
                        : nextTurnSnapshot.thinkingLevel === "off"
                            ? undefined
                            : nextTurnSnapshot.thinkingLevel,
                };
            }
            if (await config.shouldStopAfterTurn?.({
                message,
                toolResults,
                context: currentContext,
                newMessages,
            })) {
                await emit({ type: "agent_end", messages: newMessages });
                return;
            }
            pendingMessages = (await config.getSteeringMessages?.()) || [];
        }
`;

const AGENT_SESSION_PREIMAGE = String.raw`    _installAgentNextTurnRefresh() {
        const previousPrepareNextTurnWithContext = this.agent.prepareNextTurnWithContext ??
            (this.agent.prepareNextTurn
                ? async (_turn, signal) => await this.agent.prepareNextTurn?.(signal)
                : undefined);
        this.agent.prepareNextTurnWithContext = async (turn, signal) => {
            const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
            const previousContext = previousSnapshot?.context ?? turn.context;
            return {
                ...previousSnapshot,
                context: {
                    ...previousContext,
                    systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
                    tools: this.agent.state.tools.slice(),
                },
                model: this.agent.state.model,
                thinkingLevel: this.agent.state.thinkingLevel,
            };
        };
    }
`;

function fixtureLoop(prefix = "const before = 1;\n", suffix = "const after = 2;\n") {
  return `${prefix}async function runLoopFixture() {\n${AGENT_LOOP_PREIMAGE}    }\n}\n${suffix}`;
}

function fixtureSession(prefix = "const before = 1;\n", suffix = "const after = 2;\n") {
  return `${prefix}class AgentSessionFixture {\n${AGENT_SESSION_PREIMAGE}}\n${suffix}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, "utf8");
}

function makePiWebFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-pi-8782-"));
  const piWebRoot = path.join(root, "node_modules", "@agegr", "pi-web");
  const codingRoot = path.join(piWebRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const coreRoot = path.join(codingRoot, "node_modules", "@earendil-works", "pi-agent-core");
  const codingVersion = options.codingVersion || "0.84.3";
  const coreVersion = options.coreVersion || "0.84.3";
  const piWebVersion = options.piWebVersion || "0.8.11";

  writeJson(path.join(piWebRoot, "package.json"), {
    name: "@agegr/pi-web",
    version: piWebVersion,
    main: "dist/index.js",
    dependencies: {
      "@earendil-works/pi-agent-core": "0.84.3",
      "@earendil-works/pi-coding-agent": "0.84.3",
    },
  });
  writeJson(path.join(codingRoot, "package.json"), {
    name: "@earendil-works/pi-coding-agent",
    version: codingVersion,
    main: "dist/index.js",
    dependencies: { "@earendil-works/pi-agent-core": "^0.84.3" },
  });
  writeJson(path.join(coreRoot, "package.json"), {
    name: "@earendil-works/pi-agent-core",
    version: coreVersion,
    main: "dist/index.js",
  });
  writeText(path.join(piWebRoot, "dist", "index.js"), "export {};\n");
  writeText(path.join(codingRoot, "dist", "index.js"), "export {};\n");
  writeText(path.join(coreRoot, "dist", "index.js"), "export {};\n");
  writeText(path.join(coreRoot, "dist", "agent-loop.js"), options.agentLoop ?? fixtureLoop());
  writeText(path.join(codingRoot, "dist", "core", "agent-session.js"), options.agentSession ?? fixtureSession());
  return { root, piWebRoot, codingRoot, coreRoot };
}

function helper() {
  return require(path.join(repoRoot, "lib", "pui-pi-8782-backport.js"));
}

function artifactNames(runtime) {
  return [
    runtime.manifestFile,
    ...Object.values(runtime.targets).flatMap((target) => [target.file, target.backupFile]),
  ];
}

test("exact runtime transforms add only the two upstream #8782 mechanisms", () => {
  const { patchAgentLoopText, patchAgentSessionText, AGENT_LOOP_SENTINEL, AGENT_LOOP_POSTIMAGE, AGENT_SESSION_SENTINEL, AGENT_SESSION_POSTIMAGE } = helper();
  const loop = fixtureLoop();
  const session = fixtureSession();
  const loopResult = patchAgentLoopText(loop);
  const sessionResult = patchAgentSessionText(session);
  assert.equal(loopResult.ok, true);
  assert.equal(loopResult.changed, true);
  assert.equal(sessionResult.ok, true);
  assert.equal(sessionResult.changed, true);
  assert.match(loopResult.text, new RegExp(AGENT_LOOP_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sessionResult.text, new RegExp(AGENT_SESSION_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(loopResult.text, /let lastCompletedTurn;/);
  assert.match(loopResult.text, /config\.prepareNextTurn\?\.\(lastCompletedTurn\)/);
  assert.match(loopResult.text, /shouldStopAfterTurn\?\.\(lastCompletedTurn\)/);
  assert.match(sessionResult.text, /_compactBeforeNextAssistantResponse\(context\)/);
  assert.match(sessionResult.text, /shouldCompact\(estimateContextTokens\(context\.messages\)\.tokens/);
  assert.match(sessionResult.text, /_runAutoCompaction\("threshold", false\)/);
  assert.match(sessionResult.text, /messages: this\.agent\.state\.messages\.slice\(\)/);
  assert.equal(loopResult.text.slice(0, loopResult.text.indexOf(AGENT_LOOP_POSTIMAGE)), loop.slice(0, loop.indexOf(AGENT_LOOP_PREIMAGE)));
  const loopSuffixStart = loop.indexOf(AGENT_LOOP_PREIMAGE) + AGENT_LOOP_PREIMAGE.length;
  const loopPostSuffixStart = loopResult.text.indexOf(AGENT_LOOP_POSTIMAGE) + AGENT_LOOP_POSTIMAGE.length;
  assert.equal(loopResult.text.slice(loopPostSuffixStart), loop.slice(loopSuffixStart));
  assert.equal(sessionResult.text.slice(0, sessionResult.text.indexOf(AGENT_SESSION_POSTIMAGE)), session.slice(0, session.indexOf(AGENT_SESSION_PREIMAGE)));
  const sessionSuffixStart = session.indexOf(AGENT_SESSION_PREIMAGE) + AGENT_SESSION_PREIMAGE.length;
  const sessionPostSuffixStart = sessionResult.text.indexOf(AGENT_SESSION_POSTIMAGE) + AGENT_SESSION_POSTIMAGE.length;
  assert.equal(sessionResult.text.slice(sessionPostSuffixStart), session.slice(sessionSuffixStart));
});

test("pure transforms reject missing and duplicate compiled anchors", () => {
  const { patchAgentLoopText, patchAgentSessionText } = helper();
  assert.equal(patchAgentLoopText("missing").reason, "anchor-missing");
  assert.equal(patchAgentSessionText("missing").reason, "anchor-missing");
  assert.equal(patchAgentLoopText(fixtureLoop() + fixtureLoop()).reason, "anchor-multiple");
  assert.equal(patchAgentSessionText(fixtureSession() + fixtureSession()).reason, "anchor-multiple");
  const loopPatched = patchAgentLoopText(fixtureLoop());
  const sessionPatched = patchAgentSessionText(fixtureSession());
  assert.equal(patchAgentLoopText(loopPatched.text).reason, "already-patched");
  assert.equal(patchAgentSessionText(sessionPatched.text).reason, "already-patched");
  assert.equal(patchAgentLoopText(loopPatched.text.replace("lastCompletedTurn", "changed")).reason, "patched-drift");
  assert.equal(patchAgentSessionText(sessionPatched.text.replace("_compactBeforeNextAssistantResponse", "changed")).reason, "patched-drift");
});

test("resolver follows Pi Web's private coding-agent and agent-core tree", (t) => {
  const { resolveRuntime } = helper();
  const fixture = makePiWebFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const runtime = resolveRuntime({ piWebRoot: fixture.piWebRoot });
  assert.equal(runtime.piWebRoot, path.resolve(fixture.piWebRoot));
  assert.equal(runtime.codingAgentRoot, path.resolve(fixture.codingRoot));
  assert.equal(runtime.agentCoreRoot, path.resolve(fixture.coreRoot));
  assert.equal(runtime.targets.agentLoop.relative, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js");
  assert.equal(runtime.targets.agentSession.relative, "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
});

test("resolver rejects a coding-agent shared outside the Pi Web package tree", (t) => {
  const { resolveRuntime } = helper();
  const fixture = makePiWebFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.rmSync(fixture.codingRoot, { recursive: true, force: true });
  const sharedRoot = path.join(fixture.root, "node_modules", "@earendil-works", "pi-coding-agent");
  writeJson(path.join(sharedRoot, "package.json"), { name: "@earendil-works/pi-coding-agent", version: "0.84.3", main: "dist/index.js" });
  writeText(path.join(sharedRoot, "dist", "index.js"), "export {};\n");
  assert.throws(() => resolveRuntime({ piWebRoot: fixture.piWebRoot }), /outside Pi Web/);
});

test("apply is version-anchored and all-or-nothing before writing either runtime file", (t) => {
  const { apply, patchAgentLoopText } = helper();
  const wrongPi = makePiWebFixture({ codingVersion: "0.84.4" });
  const wrongCore = makePiWebFixture({ coreVersion: "0.84.4" });
  const wrongWeb = makePiWebFixture({ piWebVersion: "0.8.12" });
  const duplicate = makePiWebFixture({ agentLoop: fixtureLoop() + fixtureLoop() });
  const missing = makePiWebFixture({ agentSession: "export {};\n" });
  const onePatched = makePiWebFixture({ agentLoop: patchAgentLoopText(fixtureLoop()).text });
  for (const fixture of [wrongPi, wrongCore, wrongWeb, duplicate, missing, onePatched]) t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(apply({ repoRoot, piWebRoot: wrongPi.piWebRoot }).reason, "coding-agent-version-mismatch");
  assert.equal(apply({ repoRoot, piWebRoot: wrongCore.piWebRoot }).reason, "agent-core-version-mismatch");
  assert.equal(apply({ repoRoot, piWebRoot: wrongWeb.piWebRoot }).reason, "pi-web-version-mismatch");
  assert.equal(apply({ repoRoot, piWebRoot: duplicate.piWebRoot }).reason, "anchor-multiple");
  assert.equal(apply({ repoRoot, piWebRoot: missing.piWebRoot }).reason, "anchor-missing");
  assert.equal(apply({ repoRoot, piWebRoot: onePatched.piWebRoot }).reason, "ownership-missing");
  for (const fixture of [wrongPi, wrongCore, wrongWeb, duplicate, missing, onePatched]) {
    const loopFile = path.join(fixture.codingRoot, "node_modules", "@earendil-works", "pi-agent-core", "dist", "agent-loop.js");
    const sessionFile = path.join(fixture.codingRoot, "dist", "core", "agent-session.js");
    assert.equal(fs.existsSync(`${loopFile}.pui-8782-original`), false);
    assert.equal(fs.existsSync(`${sessionFile}.pui-8782-original`), false);
    assert.equal(fs.existsSync(path.join(fixture.piWebRoot, ".pui-pi-8782-backport.json")), false);
  }
});

test("apply verifies syntax and rolls back both files after a post-write failure", (t) => {
  const { apply, resolveRuntime } = helper();
  const fixture = makePiWebFixture({ agentLoop: "const = ;\n" + AGENT_LOOP_PREIMAGE });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const runtime = resolveRuntime({ piWebRoot: fixture.piWebRoot });
  const before = Object.fromEntries(Object.entries(runtime.targets).map(([name, target]) => [name, fs.readFileSync(target.file, "utf8")]));
  const result = apply({ repoRoot, piWebRoot: fixture.piWebRoot });
  assert.equal(result.reason, "syntax-check-failed");
  for (const [name, target] of Object.entries(runtime.targets)) assert.equal(fs.readFileSync(target.file, "utf8"), before[name]);
  assert.deepEqual(artifactNames(runtime).filter((file) => fs.existsSync(file)), [runtime.targets.agentLoop.file, runtime.targets.agentSession.file]);
});

test("failed rollback retains recovery evidence and reports both failures", (t) => {
  const { apply, resolveRuntime } = helper();
  const fixture = makePiWebFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const runtime = resolveRuntime({ piWebRoot: fixture.piWebRoot });
  const originals = Object.fromEntries(Object.entries(runtime.targets).map(([name, target]) => [name, fs.readFileSync(target.file, "utf8")]));
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  let manifestWritten = false;
  let rollbackStarted = false;
  fs.writeFileSync = function (file, data, ...args) {
    const resolved = path.resolve(String(file));
    if (resolved === runtime.manifestFile) {
      const result = originalWriteFileSync.call(fs, file, data, ...args);
      manifestWritten = true;
      return result;
    }
    if (resolved === runtime.targets.agentLoop.file && data === originals.agentLoop) {
      rollbackStarted = true;
      throw new Error("injected restore failure");
    }
    return originalWriteFileSync.call(fs, file, data, ...args);
  };
  fs.readFileSync = function (file, ...args) {
    const result = originalReadFileSync.call(fs, file, ...args);
    if (manifestWritten && !rollbackStarted && path.resolve(String(file)) === runtime.manifestFile) {
      return result.replace('"owner": "PUI"', '"owner": "not-PUI"');
    }
    return result;
  };
  let result;
  try {
    result = apply({ repoRoot, piWebRoot: fixture.piWebRoot });
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(result.reason, "recovery-required");
  assert.equal(result.originalReason, "manifest-identity");
  assert.match(result.originalError, /Internal verification failed/);
  assert.match(result.rollbackError, /injected restore failure/);
  assert.match(result.error, /manifest-identity/);
  assert.match(result.error, /injected restore failure/);
  for (const target of Object.values(runtime.targets)) assert.equal(fs.existsSync(target.backupFile), true);
  assert.equal(fs.existsSync(runtime.manifestFile), true);
});

test("apply, verify, and remove preserve exact ownership and are idempotent", (t) => {
  const { apply, verify, remove, resolveRuntime, MANIFEST } = helper();
  const fixture = makePiWebFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const runtime = resolveRuntime({ piWebRoot: fixture.piWebRoot });
  const originals = Object.fromEntries(Object.entries(runtime.targets).map(([name, target]) => [name, fs.readFileSync(target.file, "utf8")]));
  assert.equal(apply({ repoRoot, piWebRoot: fixture.piWebRoot }).action, "patched");
  assert.equal(verify({ repoRoot, piWebRoot: fixture.piWebRoot }).ok, true);
  assert.equal(apply({ repoRoot, piWebRoot: fixture.piWebRoot }).action, "already-patched");
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.piWebRoot, MANIFEST), "utf8"));
  assert.equal(manifest.owner, "PUI");
  assert.equal(manifest.piWebVersion, "0.8.11");
  assert.equal(manifest.piVersion, "0.84.3");
  assert.equal(manifest.upstreamPr, 8782);
  for (const [name, target] of Object.entries(runtime.targets)) assert.equal(fs.readFileSync(target.backupFile, "utf8"), originals[name]);
  assert.equal(remove(fixture.piWebRoot).action, "removed");
  for (const [name, target] of Object.entries(runtime.targets)) assert.equal(fs.readFileSync(target.file, "utf8"), originals[name]);
  assert.equal(verify({ repoRoot, piWebRoot: fixture.piWebRoot }).reason, "manifest-missing");
  assert.equal(remove(fixture.piWebRoot).action, "absent");
});

test("remove preserves modified targets, backups, and manifests", (t) => {
  const { apply, remove, resolveRuntime, verify, MANIFEST } = helper();
  const targetFixture = makePiWebFixture();
  const backupFixture = makePiWebFixture();
  const manifestFixture = makePiWebFixture();
  for (const fixture of [targetFixture, backupFixture, manifestFixture]) t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  for (const fixture of [targetFixture, backupFixture, manifestFixture]) assert.equal(apply({ repoRoot, piWebRoot: fixture.piWebRoot }).ok, true);

  const targetRuntime = resolveRuntime({ piWebRoot: targetFixture.piWebRoot });
  fs.appendFileSync(targetRuntime.targets.agentLoop.file, "\n// user modification\n");
  assert.equal(verify({ repoRoot, piWebRoot: targetFixture.piWebRoot }).ok, false);
  assert.equal(remove(targetFixture.piWebRoot).action, "preserved");
  assert.equal(fs.existsSync(path.join(targetFixture.piWebRoot, MANIFEST)), true);

  const backupRuntime = resolveRuntime({ piWebRoot: backupFixture.piWebRoot });
  fs.appendFileSync(backupRuntime.targets.agentLoop.backupFile, "\n// backup modification\n");
  assert.equal(verify({ repoRoot, piWebRoot: backupFixture.piWebRoot }).ok, false);
  assert.equal(remove(backupFixture.piWebRoot).action, "preserved");

  const manifestFile = path.join(manifestFixture.piWebRoot, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.owner = "not-PUI";
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest)}\n`, "utf8");
  assert.equal(verify({ repoRoot, piWebRoot: manifestFixture.piWebRoot }).ok, false);
  assert.equal(remove(manifestFixture.piWebRoot).action, "preserved");
});

test("unsupported helper constants remain tied to the current stack composition", () => {
  const { SUPPORTED_PI_VERSION, SUPPORTED_PI_WEB_VERSION, UPSTREAM_PR, UPSTREAM_MERGE_COMMIT } = helper();
  const stack = require(path.join(repoRoot, "stack.json"));
  assert.equal(SUPPORTED_PI_VERSION, stack.upstream.agentRuntime.version);
  assert.equal(SUPPORTED_PI_WEB_VERSION, stack.upstream.gui.version);
  assert.equal(UPSTREAM_PR, 8782);
  assert.equal(UPSTREAM_MERGE_COMMIT, "56700d42ed65a94a80af7376adb19a9298065164");
});
