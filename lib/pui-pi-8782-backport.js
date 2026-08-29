#!/usr/bin/env node
// Temporary PUI-owned compatibility backport for upstream Pi #8782.
// It patches only the unbundled Pi runtime that the managed Pi Web package
// resolves: agent-loop scheduling and AgentSession between-turn compaction.
// This helper is intentionally exact-version and fail-closed so it can be
// deleted when PUI pins a Pi release containing the upstream fix.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { findPackageJSON } = require("node:module");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadRelease } = require("./pui-release.js");

const PI_WEB_PACKAGE = "@agegr/pi-web";
const CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const AGENT_CORE_PACKAGE = "@earendil-works/pi-agent-core";
const SUPPORTED_PI_WEB_VERSION = "0.8.11";
const SUPPORTED_PI_VERSION = "0.84.3";
const UPSTREAM_PR = 8782;
const UPSTREAM_MERGE_COMMIT = "56700d42ed65a94a80af7376adb19a9298065164";
const MANIFEST = ".pui-pi-8782-backport.json";
const BACKUP_SUFFIX = ".pui-8782-original";
const AGENT_LOOP_SENTINEL = "/* pui-pi-8782-backport:agent-loop */";
const AGENT_SESSION_SENTINEL = "/* pui-pi-8782-backport:agent-session */";

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

const AGENT_LOOP_POSTIMAGE = String.raw`    ${AGENT_LOOP_SENTINEL}
    let lastCompletedTurn;
    // Check for steering messages at start (user may have typed while waiting)
    let pendingMessages = (await config.getSteeringMessages?.()) || [];
    // Outer loop: continues when queued follow-up messages arrive after agent would stop
    while (true) {
        let hasMoreToolCalls = true;
        // Inner loop: process tool calls and steering messages
        while (hasMoreToolCalls || pendingMessages.length > 0) {
            if (lastCompletedTurn) {
                const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
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
                // Preparation can be long-running (for example, compaction). Pick up steering
                // queued while it ran. Only poll again if the earlier poll returned nothing;
                // otherwise one-at-a-time mode would deliver two messages in this turn.
                if (pendingMessages.length === 0) {
                    pendingMessages = (await config.getSteeringMessages?.()) || [];
                }
                await emit({ type: "turn_start" });
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
            lastCompletedTurn = {
                message,
                toolResults,
                context: currentContext,
                newMessages,
            };

            if (await config.shouldStopAfterTurn?.(lastCompletedTurn)) {
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

const AGENT_SESSION_POSTIMAGE = String.raw`    ${AGENT_SESSION_SENTINEL}
    async _compactBeforeNextAssistantResponse(context) {
        const model = this.model;
        const settings = this.settingsManager.getCompactionSettings();

        if (!model ||
            model.contextWindow <= 0 ||
            !shouldCompact(estimateContextTokens(context.messages).tokens, model.contextWindow, settings)) {
            return context;
        }

        await this._runAutoCompaction("threshold", false);
        return {
            ...context,
            messages: this.agent.state.messages.slice(),
        };
    }

    _installAgentNextTurnRefresh() {
        const previousPrepareNextTurnWithContext = this.agent.prepareNextTurnWithContext ??
            (this.agent.prepareNextTurn
                ? async (_turn, signal) => await this.agent.prepareNextTurn?.(signal)
                : undefined);
        this.agent.prepareNextTurnWithContext = async (turn, signal) => {
            const context = await this._compactBeforeNextAssistantResponse(turn.context);
            const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
            const nextContext = previousSnapshot?.context ?? context;
            return {
                ...previousSnapshot,
                context: {
                    ...nextContext,
                    systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
                    tools: this.agent.state.tools.slice(),
                },
                model: this.agent.state.model,
                thinkingLevel: this.agent.state.thinkingLevel,
            };
        };
    }
`;

const TARGETS = {
  agentLoop: { packageName: AGENT_CORE_PACKAGE, packageRelative: "dist/agent-loop.js", sentinel: AGENT_LOOP_SENTINEL },
  agentSession: { packageName: CODING_AGENT_PACKAGE, packageRelative: "dist/core/agent-session.js", sentinel: AGENT_SESSION_SENTINEL },
};

class BackportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new BackportError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function patchText(text, preimage, postimage, sentinel) {
  if (typeof text !== "string") return { ok: false, changed: false, reason: "invalid-text" };
  const sentinelCount = countOccurrences(text, sentinel);
  if (sentinelCount > 0) {
    if (sentinelCount === 1 && countOccurrences(text, postimage) === 1 && countOccurrences(text, preimage) === 0) {
      return { ok: true, changed: false, reason: "already-patched", text };
    }
    return { ok: false, changed: false, reason: "patched-drift", text };
  }
  const anchorCount = countOccurrences(text, preimage);
  if (anchorCount === 0) return { ok: false, changed: false, reason: "anchor-missing", text };
  if (anchorCount !== 1) return { ok: false, changed: false, reason: "anchor-multiple", text };
  return { ok: true, changed: true, reason: "patched", text: text.replace(preimage, postimage) };
}

function patchAgentLoopText(text) {
  return patchText(text, AGENT_LOOP_PREIMAGE, AGENT_LOOP_POSTIMAGE, AGENT_LOOP_SENTINEL);
}

function patchAgentSessionText(text) {
  return patchText(text, AGENT_SESSION_PREIMAGE, AGENT_SESSION_POSTIMAGE, AGENT_SESSION_SENTINEL);
}

function assertSupportedStack(repoRoot) {
  if (typeof repoRoot !== "string" || !repoRoot) fail("repo-root-missing", "PUI repository root is required");
  let release;
  try {
    release = loadRelease(repoRoot);
  } catch (error) {
    fail("invalid-repository", error.message);
  }
  const pi = release.stack.upstream?.agentRuntime;
  const gui = release.stack.upstream?.gui;
  if (pi?.npm !== CODING_AGENT_PACKAGE || pi?.version !== SUPPORTED_PI_VERSION || gui?.npm !== PI_WEB_PACKAGE || gui?.version !== SUPPORTED_PI_WEB_VERSION) {
    fail("stack-version-mismatch", `Pi #8782 backport supports ${CODING_AGENT_PACKAGE}@${SUPPORTED_PI_VERSION} with ${PI_WEB_PACKAGE}@${SUPPORTED_PI_WEB_VERSION}`);
  }
  return release;
}

function readPackage(packageRoot) {
  const packageFile = path.join(packageRoot, "package.json");
  if (!fs.existsSync(packageFile)) fail("package-json-missing", `Package metadata was not found: ${packageFile}`);
  try {
    return JSON.parse(fs.readFileSync(packageFile, "utf8"));
  } catch (error) {
    fail("invalid-package-json", `${packageFile}: ${error.message}`);
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function packageRootFromResolved(resolvedFile, packageName) {
  let cursor = path.dirname(resolvedFile);
  while (true) {
    const packageFile = path.join(cursor, "package.json");
    if (fs.existsSync(packageFile)) {
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(packageFile, "utf8")); }
      catch (error) { fail("invalid-package-json", `${packageFile}: ${error.message}`); }
      if (manifest.name === packageName) return path.resolve(cursor);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  fail("package-root-missing", `Could not locate ${packageName} from ${resolvedFile}`);
}

function resolvePackageFrom(packageRoot, packageName) {
  try {
    // findPackageJSON uses Node's own package-resolution algorithm and works
    // for the ESM-only packages used by Pi, where createRequire().resolve()
    // cannot select the package's import condition.
    const packageFile = findPackageJSON(packageName, path.join(packageRoot, "package.json"));
    if (!packageFile) fail("runtime-resolution-failed", `Pi Web could not resolve ${packageName}`);
    const root = path.dirname(packageFile);
    const manifest = readPackage(root);
    const rootExport = typeof manifest.exports === "string" ? manifest.exports : manifest.exports?.["."];
    const entry = typeof rootExport === "string"
      ? rootExport
      : rootExport && typeof rootExport.import === "string"
        ? rootExport.import
        : typeof manifest.main === "string"
          ? manifest.main
          : "index.js";
    const resolved = path.resolve(root, entry);
    if (!isWithin(root, resolved)) fail("runtime-resolution-failed", `Resolved ${packageName} outside its package root: ${resolved}`);
    return resolved;
  } catch (error) {
    if (error instanceof BackportError) throw error;
    fail("runtime-resolution-failed", `Pi Web could not resolve ${packageName}: ${error.message}`);
  }
}

function packageIdentity(packageRoot, expectedName, expectedVersion, label) {
  const manifest = readPackage(packageRoot);
  if (manifest.name !== expectedName) fail(`${label}-name-mismatch`, `Expected ${expectedName}, found ${manifest.name || "unknown"}`);
  if (manifest.version !== expectedVersion) fail(`${label}-version-mismatch`, `Expected ${expectedName}@${expectedVersion}, found ${manifest.version || "unknown"}`);
  return manifest;
}

function resolveRuntime({ piWebRoot }) {
  if (typeof piWebRoot !== "string" || !piWebRoot) fail("pi-web-root-missing", "Pi Web package root is required");
  if (!fs.existsSync(piWebRoot)) fail("pi-web-root-missing", `Pi Web package root was not found: ${piWebRoot}`);
  const webRoot = fs.realpathSync(path.resolve(piWebRoot));
  packageIdentity(webRoot, PI_WEB_PACKAGE, SUPPORTED_PI_WEB_VERSION, "pi-web");

  const codingResolved = resolvePackageFrom(webRoot, CODING_AGENT_PACKAGE);
  const codingRoot = fs.realpathSync(packageRootFromResolved(codingResolved, CODING_AGENT_PACKAGE));
  if (!isWithin(webRoot, codingRoot)) fail("shared-runtime-outside-pi-web", `Resolved ${CODING_AGENT_PACKAGE} outside Pi Web: ${codingRoot}`);
  packageIdentity(codingRoot, CODING_AGENT_PACKAGE, SUPPORTED_PI_VERSION, "coding-agent");

  const coreResolved = resolvePackageFrom(codingRoot, AGENT_CORE_PACKAGE);
  const agentCoreRoot = fs.realpathSync(packageRootFromResolved(coreResolved, AGENT_CORE_PACKAGE));
  if (!isWithin(webRoot, agentCoreRoot)) fail("shared-runtime-outside-pi-web", `Resolved ${AGENT_CORE_PACKAGE} outside Pi Web: ${agentCoreRoot}`);
  packageIdentity(agentCoreRoot, AGENT_CORE_PACKAGE, SUPPORTED_PI_VERSION, "agent-core");

  const targets = {};
  for (const [name, target] of Object.entries(TARGETS)) {
    const packageRoot = name === "agentLoop" ? agentCoreRoot : codingRoot;
    const file = path.join(packageRoot, ...target.packageRelative.split("/"));
    if (!fs.existsSync(file)) fail("target-missing", `Expected Pi #8782 target was not found: ${file}`);
    const relative = path.relative(webRoot, file).split(path.sep).join("/");
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) fail("target-outside-pi-web", `Target is outside Pi Web: ${file}`);
    targets[name] = {
      file,
      relative,
      backupFile: `${file}${BACKUP_SUFFIX}`,
      backupRelative: `${relative}${BACKUP_SUFFIX}`,
      sentinel: target.sentinel,
    };
  }
  return {
    piWebRoot: webRoot,
    codingAgentRoot: codingRoot,
    agentCoreRoot,
    targets,
    manifestFile: path.join(webRoot, MANIFEST),
  };
}

function readTargets(runtime) {
  const current = {};
  for (const [name, target] of Object.entries(runtime.targets)) {
    try { current[name] = fs.readFileSync(target.file, "utf8"); }
    catch (error) { fail("target-read-failed", `${target.file}: ${error.message}`); }
  }
  return current;
}

function transformTargets(current) {
  const loop = patchAgentLoopText(current.agentLoop);
  if (!loop.ok) return { ok: false, reason: loop.reason, file: "agent-loop" };
  const session = patchAgentSessionText(current.agentSession);
  if (!session.ok) return { ok: false, reason: session.reason, file: "agent-session" };
  return {
    ok: true,
    changed: loop.changed || session.changed,
    files: { agentLoop: loop.text, agentSession: session.text },
  };
}

function nodeCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return { ok: false, detail: result.error?.message || result.stderr || `node --check exited ${result.status}` };
  return { ok: true };
}

function manifestCore(manifest) {
  return {
    owner: manifest.owner,
    schemaVersion: manifest.schemaVersion,
    piWebVersion: manifest.piWebVersion,
    piVersion: manifest.piVersion,
    upstreamPr: manifest.upstreamPr,
    upstreamMergeCommit: manifest.upstreamMergeCommit,
    files: manifest.files,
  };
}

function createManifest(runtime, originals, patched) {
  const files = {};
  for (const [name, target] of Object.entries(runtime.targets)) {
    files[target.relative] = {
      originalHash: sha256(originals[name]),
      patchedHash: sha256(patched[name]),
      backup: target.backupRelative,
    };
  }
  const manifest = {
    owner: "PUI",
    schemaVersion: 1,
    piWebVersion: SUPPORTED_PI_WEB_VERSION,
    piVersion: SUPPORTED_PI_VERSION,
    upstreamPr: UPSTREAM_PR,
    upstreamMergeCommit: UPSTREAM_MERGE_COMMIT,
    files,
  };
  manifest.identityHash = sha256(JSON.stringify(manifestCore(manifest)));
  return manifest;
}

function strictKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function readManifest(runtime) {
  if (!fs.existsSync(runtime.manifestFile)) return { ok: false, reason: "manifest-missing" };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(runtime.manifestFile, "utf8")); }
  catch (error) { return { ok: false, reason: "manifest-invalid", detail: error.message }; }
  const topKeys = ["owner", "schemaVersion", "piWebVersion", "piVersion", "upstreamPr", "upstreamMergeCommit", "files", "identityHash"];
  if (!strictKeys(manifest, topKeys) || manifest.owner !== "PUI" || manifest.schemaVersion !== 1 || manifest.piWebVersion !== SUPPORTED_PI_WEB_VERSION || manifest.piVersion !== SUPPORTED_PI_VERSION || manifest.upstreamPr !== UPSTREAM_PR || manifest.upstreamMergeCommit !== UPSTREAM_MERGE_COMMIT) {
    return { ok: false, reason: "manifest-identity" };
  }
  const targetPaths = Object.values(runtime.targets).map((target) => target.relative);
  if (!strictKeys(manifest.files, targetPaths)) return { ok: false, reason: "manifest-files" };
  for (const target of Object.values(runtime.targets)) {
    const record = manifest.files[target.relative];
    if (!strictKeys(record, ["originalHash", "patchedHash", "backup"]) || !/^[a-f0-9]{64}$/.test(record.originalHash) || !/^[a-f0-9]{64}$/.test(record.patchedHash) || record.backup !== target.backupRelative) return { ok: false, reason: "manifest-files" };
  }
  if (manifest.identityHash !== sha256(JSON.stringify(manifestCore(manifest)))) return { ok: false, reason: "manifest-hash" };
  return { ok: true, manifest };
}

function verifyRuntime(runtime) {
  const manifestResult = readManifest(runtime);
  if (!manifestResult.ok) return manifestResult;
  for (const [name, target] of Object.entries(runtime.targets)) {
    if (!fs.existsSync(target.file) || !fs.existsSync(target.backupFile)) return { ok: false, reason: "artifact-missing", file: target.file };
    const original = fs.readFileSync(target.backupFile, "utf8");
    const current = fs.readFileSync(target.file, "utf8");
    const record = manifestResult.manifest.files[target.relative];
    if (sha256(original) !== record.originalHash || sha256(current) !== record.patchedHash) return { ok: false, reason: "hash-mismatch", file: target.file };
    const originalTransform = name === "agentLoop" ? patchAgentLoopText(original) : patchAgentSessionText(original);
    if (!originalTransform.ok || !originalTransform.changed || sha256(originalTransform.text) !== record.patchedHash) return { ok: false, reason: "original-shape", file: target.backupFile };
    const patched = name === "agentLoop" ? patchAgentLoopText(current) : patchAgentSessionText(current);
    if (!patched.ok || patched.reason !== "already-patched") return { ok: false, reason: "patched-shape", file: target.file };
    const syntax = nodeCheck(target.file);
    if (!syntax.ok) return { ok: false, reason: "syntax-check-failed", file: target.file, detail: syntax.detail };
  }
  return { ok: true };
}

function rollbackFiles(runtime, originals, createdBackups, createdManifest, manifestText) {
  const restoreFailures = [];
  for (const [name, target] of Object.entries(runtime.targets)) {
    try {
      fs.writeFileSync(target.file, originals[name], "utf8");
    } catch (error) {
      restoreFailures.push(`${target.file}: ${error.message}`);
    }
  }
  const verificationFailures = [];
  for (const [name, target] of Object.entries(runtime.targets)) {
    try {
      const restored = fs.readFileSync(target.file, "utf8");
      if (restored !== originals[name]) verificationFailures.push(`${target.file}: restored content mismatch`);
    } catch (error) {
      verificationFailures.push(`${target.file}: ${error.message}`);
    }
  }
  if (restoreFailures.length || verificationFailures.length) {
    return { ok: false, reason: "recovery-required", rollbackError: [...restoreFailures, ...verificationFailures].join("; ") };
  }

  const cleanupFailures = [];
  for (const file of createdBackups) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
      cleanupFailures.push(`${file}: ${error.message}`);
    }
  }
  if (createdManifest) {
    try {
      if (fs.existsSync(runtime.manifestFile)) fs.unlinkSync(runtime.manifestFile);
    } catch (error) {
      cleanupFailures.push(`${runtime.manifestFile}: ${error.message}`);
    }
  }
  if (cleanupFailures.length) {
    for (const [name, target] of Object.entries(runtime.targets)) {
      try {
        if (!fs.existsSync(target.backupFile)) fs.writeFileSync(target.backupFile, originals[name], "utf8");
      } catch (error) {
        cleanupFailures.push(`${target.backupFile}: ${error.message}`);
      }
    }
    if (createdManifest && manifestText !== undefined) {
      try {
        fs.writeFileSync(runtime.manifestFile, manifestText, "utf8");
      } catch (error) {
        cleanupFailures.push(`${runtime.manifestFile}: ${error.message}`);
      }
    }
    return { ok: false, reason: "recovery-required", rollbackError: cleanupFailures.join("; ") };
  }
  return { ok: true };
}

function commitPatch({ runtime, originals, patched, preserveBackups = false, preserveManifest = false }) {
  const createdBackups = [];
  let createdManifest = false;
  let manifestText;
  try {
    for (const target of Object.values(runtime.targets)) {
      if (!fs.existsSync(target.backupFile)) {
        createdBackups.push(target.backupFile);
        fs.copyFileSync(target.file, target.backupFile);
      } else if (!preserveBackups) {
        fail("backup-exists", `Unexpected existing backup: ${target.backupFile}`);
      }
    }
    for (const [name, target] of Object.entries(runtime.targets)) fs.writeFileSync(target.file, patched[name], "utf8");
    for (const target of Object.values(runtime.targets)) {
      const syntax = nodeCheck(target.file);
      if (!syntax.ok) fail("syntax-check-failed", `${target.file}: ${syntax.detail}`);
    }
    if (!preserveManifest) {
      createdManifest = true;
      manifestText = `${JSON.stringify(createManifest(runtime, originals, patched), null, 2)}\n`;
      fs.writeFileSync(runtime.manifestFile, manifestText, "utf8");
    }
    const verified = verifyRuntime(runtime);
    if (!verified.ok) fail(verified.reason, verified.detail || `Internal verification failed for ${verified.file || "Pi #8782 backport"}`);
    return { ok: true };
  } catch (error) {
    const rollback = rollbackFiles(runtime, originals, createdBackups, createdManifest, manifestText);
    if (!rollback.ok) {
      const originalReason = error.code || "error";
      const recoveryError = new BackportError(
        "recovery-required",
        `Rollback failed after ${originalReason}: ${error.message}; ${rollback.rollbackError}`,
      );
      recoveryError.originalReason = originalReason;
      recoveryError.originalError = error.message;
      recoveryError.rollbackError = rollback.rollbackError;
      throw recoveryError;
    }
    throw error;
  }
}

function apply({ repoRoot, piWebRoot }) {
  try {
    assertSupportedStack(repoRoot);
    const runtime = resolveRuntime({ piWebRoot });
    const current = readTargets(runtime);
    const manifestExists = fs.existsSync(runtime.manifestFile);
    const backupExists = Object.values(runtime.targets).map((target) => fs.existsSync(target.backupFile));
    const backupCount = backupExists.filter(Boolean).length;

    if (!manifestExists && backupCount === 0) {
      if (Object.values(current).some((text) => text.includes(AGENT_LOOP_SENTINEL) || text.includes(AGENT_SESSION_SENTINEL))) return { ok: false, reason: "ownership-missing" };
      const transformed = transformTargets(current);
      if (!transformed.ok) return transformed;
      const result = commitPatch({ runtime, originals: current, patched: transformed.files });
      return { ...result, action: "patched", targets: Object.values(runtime.targets).map((target) => target.relative) };
    }

    if (backupCount !== 0 && backupCount !== Object.keys(runtime.targets).length) return { ok: false, reason: "incomplete-owned-shape" };
    if (!manifestExists && backupCount === Object.keys(runtime.targets).length) {
      const originals = {};
      for (const [name, target] of Object.entries(runtime.targets)) originals[name] = fs.readFileSync(target.backupFile, "utf8");
      const transformed = transformTargets(originals);
      if (!transformed.ok || !transformed.changed) return { ok: false, reason: transformed.ok ? "backup-invalid" : transformed.reason };
      const states = Object.keys(runtime.targets).map((name) => current[name] === originals[name] ? "original" : current[name] === transformed.files[name] ? "patched" : "drift");
      if (states.some((state) => state === "drift") || new Set(states).size !== 1) return { ok: false, reason: "incomplete-owned-shape" };
      const result = commitPatch({ runtime, originals, patched: transformed.files, preserveBackups: true });
      return { ...result, action: states[0] === "patched" ? "adopted" : "patched", targets: Object.values(runtime.targets).map((target) => target.relative) };
    }

    const ownership = readManifest(runtime);
    if (!ownership.ok) return ownership;
    const originals = {};
    for (const [name, target] of Object.entries(runtime.targets)) {
      if (!fs.existsSync(target.backupFile)) return { ok: false, reason: "backup-missing", file: target.backupFile };
      originals[name] = fs.readFileSync(target.backupFile, "utf8");
      if (sha256(originals[name]) !== ownership.manifest.files[target.relative].originalHash) return { ok: false, reason: "backup-hash-mismatch", file: target.backupFile };
    }
    const transformed = transformTargets(originals);
    if (!transformed.ok || !transformed.changed) return { ok: false, reason: transformed.ok ? "backup-invalid" : transformed.reason };
    const states = Object.keys(runtime.targets).map((name) => current[name] === originals[name] ? "original" : current[name] === transformed.files[name] ? "patched" : "drift");
    if (states.some((state) => state === "drift") || new Set(states).size !== 1) return { ok: false, reason: "installed-drift" };
    if (states[0] === "patched") {
      const verified = verifyRuntime(runtime);
      return verified.ok ? { ok: true, action: "already-patched", targets: Object.values(runtime.targets).map((target) => target.relative) } : verified;
    }
    const result = commitPatch({ runtime, originals, patched: transformed.files, preserveBackups: true, preserveManifest: true });
    return { ...result, action: "patched", targets: Object.values(runtime.targets).map((target) => target.relative) };
  } catch (error) {
    const result = { ok: false, reason: error.code || "error", error: error.message };
    if (error.originalReason !== undefined) result.originalReason = error.originalReason;
    if (error.originalError !== undefined) result.originalError = error.originalError;
    if (error.rollbackError !== undefined) result.rollbackError = error.rollbackError;
    return result;
  }
}

function verify({ repoRoot, piWebRoot }) {
  try {
    assertSupportedStack(repoRoot);
    return verifyRuntime(resolveRuntime({ piWebRoot }));
  } catch (error) {
    return { ok: false, reason: error.code || "error", error: error.message };
  }
}

function remove(piWebRoot) {
  if (typeof piWebRoot !== "string" || !piWebRoot || !fs.existsSync(piWebRoot)) return { ok: true, action: "absent" };
  let runtime;
  try { runtime = resolveRuntime({ piWebRoot }); }
  catch (error) { return { ok: false, action: "preserved", reason: error.code || "error", error: error.message }; }
  const manifestExists = fs.existsSync(runtime.manifestFile);
  const backups = Object.values(runtime.targets).filter((target) => fs.existsSync(target.backupFile));
  const sentinelPresent = Object.values(runtime.targets).some((target) => {
    try { return fs.readFileSync(target.file, "utf8").includes(target.sentinel); } catch { return false; }
  });
  if (!manifestExists && backups.length === 0 && !sentinelPresent) return { ok: true, action: "absent" };
  if (!manifestExists || backups.length !== Object.keys(runtime.targets).length) return { ok: false, action: "preserved", reason: "incomplete-owned-shape" };
  const ownership = readManifest(runtime);
  if (!ownership.ok) return { ok: false, action: "preserved", reason: ownership.reason };
  const manifestText = fs.readFileSync(runtime.manifestFile, "utf8");
  const current = {};
  const originals = {};
  for (const [name, target] of Object.entries(runtime.targets)) {
    current[name] = fs.readFileSync(target.file, "utf8");
    originals[name] = fs.readFileSync(target.backupFile, "utf8");
    const record = ownership.manifest.files[target.relative];
    const originalTransform = name === "agentLoop" ? patchAgentLoopText(originals[name]) : patchAgentSessionText(originals[name]);
    if (sha256(current[name]) !== record.patchedHash || sha256(originals[name]) !== record.originalHash || !originalTransform.ok || !originalTransform.changed || sha256(originalTransform.text) !== record.patchedHash) return { ok: false, action: "preserved", reason: "modified", file: target.file };
  }
  try {
    for (const [name, target] of Object.entries(runtime.targets)) fs.writeFileSync(target.file, originals[name], "utf8");
    for (const target of Object.values(runtime.targets)) fs.unlinkSync(target.backupFile);
    fs.unlinkSync(runtime.manifestFile);
    return { ok: true, action: "removed" };
  } catch (error) {
    for (const [name, target] of Object.entries(runtime.targets)) {
      try { fs.writeFileSync(target.file, current[name], "utf8"); } catch { /* retain preservation warning */ }
      try { fs.writeFileSync(target.backupFile, originals[name], "utf8"); } catch { /* retain preservation warning */ }
    }
    try { if (!fs.existsSync(runtime.manifestFile)) fs.writeFileSync(runtime.manifestFile, manifestText, "utf8"); } catch { /* retain preservation warning */ }
    return { ok: false, action: "preserved", reason: "restore-failed", error: error.message };
  }
}

function main(argv) {
  const command = argv[0];
  let result;
  if (command === "apply") result = apply({ repoRoot: argv[1], piWebRoot: argv[2] });
  else if (command === "verify") result = verify({ repoRoot: argv[1], piWebRoot: argv[2] });
  else if (command === "remove") result = remove(argv[1]);
  else {
    console.error("Usage: pui-pi-8782-backport.js <apply|verify> <pui-repo-root> <pi-web-root> | remove <pi-web-root>");
    return 64;
  }
  const output = JSON.stringify(result);
  if (result.ok) console.log(output); else console.error(output);
  if (result.ok) return 0;
  return command === "remove" && result.action === "preserved" ? 2 : 1;
}

module.exports = {
  AGENT_LOOP_POSTIMAGE,
  AGENT_LOOP_PREIMAGE,
  AGENT_LOOP_SENTINEL,
  AGENT_SESSION_POSTIMAGE,
  AGENT_SESSION_PREIMAGE,
  AGENT_SESSION_SENTINEL,
  BACKUP_SUFFIX,
  MANIFEST,
  SUPPORTED_PI_VERSION,
  SUPPORTED_PI_WEB_VERSION,
  UPSTREAM_MERGE_COMMIT,
  UPSTREAM_PR,
  apply,
  patchAgentLoopText,
  patchAgentSessionText,
  remove,
  resolveRuntime,
  verify,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
