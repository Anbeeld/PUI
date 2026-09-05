#!/usr/bin/env node
// PUI-managed, version-anchored compatibility patch for
// @99percentpeople/pi-background-tasks.
//
// The upstream 2.1.1 bundle registers six tools with 27 overlapping system-
// prompt guidelines plus verbose descriptions and schema text. It also keeps
// mutable task and persistence state at module scope, which leaks across Pi's
// cached extension-factory instances. PUI compacts the metadata and gives each
// default-factory invocation its own copy of that state. Install/update reapply
// the patch after `pi install`; uninstall restores the original only while the
// installed output still exactly matches the PUI-owned transform.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const stack = require("../stack.json");

const PACKAGE_NAME = "@99percentpeople/pi-background-tasks";
const EXPECTED_VERSION = stack.upstream.backgroundTasks.version;
const PATCH_CONFIG = stack.backgroundTasksPromptPatch;
const UPDATE_STATUS_FILE = path.join(os.tmpdir(), "pui-update-status.json");
const UPDATE_LOCK_FILE = path.join(os.tmpdir(), "pui-update.lock");
const UPDATE_GUARD_FILE = path.join(os.tmpdir(), "pui-background-task-guard.json");
const SENTINEL = `/* pui-background-tasks-patch:compact-guidance-v${PATCH_CONFIG.revision} */`;
const RUNTIME_ISOLATION_SENTINEL = "/* pui-background-tasks-runtime-isolation */";
const START_ANCHOR = 'registerTool({name:"bg_start"';

const PUI_GUIDELINES = [
  "Use bg_start only when the user requests background execution, the process must remain available for later interaction, or useful work can proceed concurrently. Otherwise, when the result is needed before continuing, use foreground bash with an appropriate timeout.",
  "Calls concerning the same task execute in source order; emit dependent bg_* calls in the same assistant response. Different tasks can run concurrently. For finite work, use bg_start → bg_wait and add bg_logs only when multiline pipe or PTY output is needed.",
  "Use bg_wait once when finite completion is needed. Do not use it for persistent servers or watchers, poll with bg_status or bg_logs, or wait again after a timeout unless the user asks. A timeout leaves the task running.",
  "Use bg_status only for requested metadata, diagnosis, or listing when the task reference is unknown. Treat a returned Environment as the task's fixed launch host and cwd; an SSH task stays on that target and cwd even if the active workspace changes.",
  "After bg_send, add bg_wait or bg_logs only when completion or fuller output is needed. After bg_kill, add bg_logs only when final output is needed.",
  "Running bg_start tasks survive ordinary agent runs but terminate on reload or shutdown. Finished tasks are retained only through the current run — or the next one when they finish while idle — so collect needed output in the current workflow.",
];

const PUI_TOOL_METADATA = {
  bg_start: {
    description: "Start a background task for later interaction or useful concurrency. Use pipe mode by default and PTY only for interactive or terminal-aware programs. Returns a task reference and launch details.",
    promptSnippet: "Start background work for later use or concurrency",
  },
  bg_wait: {
    description: "Wait for a finite task to finish or time out. Returns status and the latest pipe line when available; timeout leaves the task running.",
    promptSnippet: "Wait for finite task completion",
  },
  bg_status: {
    description: "Inspect task metadata or list retained tasks without waiting. Returns the latest pipe line when available, not multiline pipe or PTY output.",
    promptSnippet: "Inspect task metadata",
  },
  bg_logs: {
    description: "Read retained pipe or parsed PTY output by recent tail or line range.",
    promptSnippet: "Read retained task output",
  },
  bg_send: {
    description: "Send exactly one input or OS signal. Input is exact; keys use <...>, and pipe <C-d> or <EOF> closes stdin. Disconnected tasks accept signals only.",
    promptSnippet: "Send task input or a signal",
  },
  bg_kill: {
    description: "Request SIGTERM, or SIGKILL with force=true. Returns termination status, not task output.",
    promptSnippet: "Stop a task",
  },
};

const ORIGINAL_TOOL_METADATA = {
  bg_start: {
    description: "Start a task asynchronously only when background execution is genuinely needed: for concurrent work, later interaction, or an explicit user request. Its unique name can immediately reference ordered follow-up bg_* calls in the same assistant response.",
    promptSnippet: "Start a genuinely asynchronous task for concurrent work or later interaction",
    guidelines: [
      "Use bg_start only when the user explicitly requests background execution, the process must remain available for later interaction (for example, a server, watcher, or TUI), or you will perform independent useful work concurrently while it runs.",
      "Do not use bg_start merely because a command may be slow. If background execution was not explicitly requested and you need its result before any independent work can proceed, use the bash tool with an appropriate timeout instead of bg_start → bg_wait → bg_logs.",
      "Give each bg_start task a unique name; names are compared case-insensitively across all currently retained tasks.",
      "Use the Environment returned by bg_start and later bg_* results as the task's immutable launch location; an SSH task stays on that target and cwd even if the active workspace changes.",
      "Set bg_start pty=true only for terminal-aware or interactive TUI programs; keep the default pipe mode for ordinary builds and servers.",
      "Once bg_start is justified, compose complete bg_* workflows in one assistant response. Every bg_* id accepts a task ID or unique name, and same-task calls execute strictly in source order, not in parallel. For example, emit bg_start(name=\"tests\") → bg_wait(id=\"tests\") → bg_logs(id=\"tests\") together; for an existing task, emit bg_wait → bg_logs together. Different tasks execute in parallel, and bg_status without id is independent.",
      "A running bg_start task survives ordinary agent runs but session reload or shutdown terminates it. A task finishing during a run is normally retained through that run; a task that was still running when the agent settled and then finishes while idle is normally retained through the next run.",
      "Use bg_wait only for finite bg_start tasks whose completion is needed. bg_wait includes the latest pipe log line when available; place bg_logs immediately after bg_wait only when full or multiline pipe output or PTY terminal output is needed. Do not poll either tool.",
    ],
  },
  bg_wait: {
    description: "Wait for a finite task to finish or time out and include its latest pipe log line when available. Use bg_logs for full pipe output or PTY terminal output.",
    promptSnippet: "Wait for finite completion and return the latest pipe log line",
    guidelines: [
      "Use bg_wait once when completion of an already-justified finite bg_start task is required; never create a bg_start task solely so you can wait on it.",
      "bg_wait returns completion status plus the latest pipe log line when available. Emit bg_logs immediately after bg_wait only when full or multiline pipe output or PTY terminal output is needed; do not wait for the bg_wait result before emitting bg_logs.",
      "A bg_wait timeout leaves the task running and still returns the latest pipe log line; a following same-response bg_logs call reads fuller output retained at that point.",
      "Do not use bg_wait for persistent servers or watchers, and do not immediately wait again after a timeout unless the user asks you to keep waiting.",
    ],
  },
  bg_status: {
    description: "Inspect task status and metadata or list current tasks, including each task's latest pipe log line when available. This is not a polling or waiting tool and does not return full or PTY output.",
    promptSnippet: "Inspect background task status with the latest pipe log line",
    guidelines: [
      "Do not poll bg_status after bg_start; use bg_wait once when a finite task's final status is required.",
      "Use bg_status only for requested task metadata, recovering a missing task reference, or diagnosing task state.",
      "Use bg_status without id only when the task ID or name is unknown and a retained-task list is needed.",
      "bg_status includes the latest pipe log line when available; use bg_logs for full or multiline pipe output and for all PTY terminal output.",
    ],
  },
  bg_logs: {
    description: "Read retained pipe or PTY output when the latest pipe line returned by bg_wait or bg_status is insufficient. Place bg_logs after bg_wait in the same response when fuller final output is needed.",
    promptSnippet: "Read full task output when a latest-line summary is insufficient",
    guidelines: [
      "Use bg_logs when you need more than the latest pipe log line returned by bg_wait or bg_status, or when you need any PTY terminal output.",
      "Use bg_logs with tail=N for recent output; omit stream to use the correct default for either pipe or PTY mode.",
      "Do not poll with bg_logs. When fuller finite output is needed, emit bg_wait followed by bg_logs in the same assistant response; source ordering makes bg_logs run after bg_wait.",
    ],
  },
  bg_send: {
    description: "Send text and terminal keys to a running task, or signal a running/disconnected adapter-owned task.",
    promptSnippet: "Send a compact text/key input string or an OS signal to a background task",
    guidelines: [
      "Provide exactly one of bg_send input or signal. bg_send input is exact text; wrap every terminal key in an angle-bracket token such as <C-d>, <A-f>, <Space>, or <Up>, and escape a literal '<' as \\<.",
      "Use bg_send input for terminal keys; use bg_send signal only when an OS process signal is explicitly intended.",
      "For a pipe task, bg_send input=<C-d> or input=<EOF> closes stdin.",
      "When bg_send is followed by waiting or output inspection, emit bg_send → bg_wait → bg_logs together in one assistant response so same-task source ordering avoids extra model rounds.",
      "For a disconnected adapter task, bg_send input is unavailable because the local transport is gone, but bg_send signal may remain usable for cleanup.",
    ],
  },
  bg_kill: {
    description: "Terminate a running or disconnected background task and report the result. Sends SIGTERM by default or SIGKILL with force=true; does not return process output.",
    promptSnippet: "Terminate an unresponsive background task",
    guidelines: [
      "Use bg_kill when a background task must be terminated.",
      "Use bg_kill with force=true to send SIGKILL immediately; otherwise bg_kill sends SIGTERM.",
      "bg_kill returns termination status only. When final output is needed, emit bg_kill followed by bg_logs in the same assistant response.",
    ],
  },
};

const GUIDELINE_TARGETS = {
  bg_start: [PUI_GUIDELINES[0], PUI_GUIDELINES[1]],
  bg_wait: [PUI_GUIDELINES[2]],
  bg_status: [PUI_GUIDELINES[3]],
  bg_logs: [],
  bg_send: [PUI_GUIDELINES[4]],
  bg_kill: [PUI_GUIDELINES[5]],
};

const PARAMETER_REPLACEMENTS = [
  ["A short unique name for the task (case-insensitive among retained tasks)", "Unique case-insensitive task name among retained tasks", 1],
  ["The shell command to run", "Shell command", 1],
  ["Working directory (defaults to current)", "Working directory; defaults to current", 1],
  ["Run in a pseudoterminal for interactive/TUI programs (default: false)", "Use a PTY for interactive or terminal-aware programs; default false", 1],
  ["Initial PTY columns (default: current terminal or 120)", "Initial PTY columns; default: current terminal or 120", 1],
  ["Initial PTY rows (default: current terminal or 30)", "Initial PTY rows; default: current terminal or 30", 1],
  ["Task ID or unique name (case-insensitive)", "Task ID or case-insensitive name", 4],
  ["Maximum seconds to wait (default: 300)", "Maximum wait in seconds; default 300", 1],
  ["Task ID or unique name. If omitted, lists all retained tasks.", "Task ID or case-insensitive name; omit to list retained tasks", 1],
  ["Read last N lines (default: 100)", "Read the last N lines; default 100", 1],
  ["Which stream (default: 'both'); use terminal for explicit PTY output", "Output stream; default 'both'; use terminal for PTY output", 1],
  ["Start from this line (0-indexed). Overrides tail.", "Zero-based first line; overrides tail", 1],
  ["Max lines with from_line (default: 500)", "Maximum range length; default 500", 1],
  ["Exact text; terminal keys must use <...> tokens, for example y<Enter>, <A-f>, or <C-d>", "Exact text or <...> key tokens; escape a literal < as \\<", 1],
  ["Named signal validated against the task's local or adapter execution environment", "Supported named OS signal for the task environment", 1],
  ["Send SIGKILL instead of SIGTERM (default: false)", "Send SIGKILL instead of SIGTERM", 1],
];

function singleQuoted(value) {
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")}'`;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function replaceStringLiteral(text, oldValue, newValue, expectedCount) {
  const forms = [...new Set([JSON.stringify(oldValue), singleQuoted(oldValue)])];
  const actual = forms.reduce((sum, form) => sum + countOccurrences(text, form), 0);
  if (actual !== expectedCount) return { ok: false, expected: expectedCount, actual, value: oldValue, text };
  let next = text;
  for (const form of forms) next = next.split(form).join(JSON.stringify(newValue));
  return { ok: true, text: next };
}

function replacementPlan() {
  const replacements = [];
  for (const [name, original] of Object.entries(ORIGINAL_TOOL_METADATA)) {
    const replacement = PUI_TOOL_METADATA[name];
    replacements.push([original.description, replacement.description, 1]);
    replacements.push([original.promptSnippet, replacement.promptSnippet, 1]);
    const targets = GUIDELINE_TARGETS[name];
    original.guidelines.forEach((guideline, index) => replacements.push([guideline, targets[index] || "", 1]));
  }
  replacements.push(...PARAMETER_REPLACEMENTS);
  return replacements;
}

function hasCompactMetadata(text) {
  if (countOccurrences(text, SENTINEL) !== 1 || countOccurrences(text, RUNTIME_ISOLATION_SENTINEL) !== 1) return false;
  const expectedMetadataCopies = 2;
  for (const metadata of Object.values(PUI_TOOL_METADATA)) {
    if (countOccurrences(text, JSON.stringify(metadata.description)) + countOccurrences(text, singleQuoted(metadata.description)) !== expectedMetadataCopies) return false;
    if (countOccurrences(text, JSON.stringify(metadata.promptSnippet)) + countOccurrences(text, singleQuoted(metadata.promptSnippet)) !== expectedMetadataCopies) return false;
  }
  for (const guideline of PUI_GUIDELINES) {
    if (countOccurrences(text, JSON.stringify(guideline)) + countOccurrences(text, singleQuoted(guideline)) !== expectedMetadataCopies) return false;
  }
  for (const targets of Object.values(GUIDELINE_TARGETS)) {
    if (countOccurrences(text, `promptGuidelines:${JSON.stringify(targets)}`) !== expectedMetadataCopies) return false;
  }
  for (const [oldValue] of replacementPlan()) {
    if (countOccurrences(text, JSON.stringify(oldValue)) + countOccurrences(text, singleQuoted(oldValue)) !== 0) return false;
  }
  return !/^[ \t]*\/\/[#@]\s*sourceMappingURL=.*$/m.test(text);
}

function isolateDefaultFactory(text) {
  let importEnd = 0;
  let importCount = 0;
  while (text.startsWith("import", importEnd)) {
    const semicolon = text.indexOf(";", importEnd);
    if (semicolon < 0) return { ok: false, reason: "runtime-import-drift", text };
    importEnd = semicolon + 1;
    importCount += 1;
  }
  if (importCount === 0) return { ok: false, reason: "runtime-import-drift", text };

  const exports = [...text.matchAll(/export\s*\{([^}]*)\}\s*;/g)]
    .filter((match) => /\bas\s+default\b/.test(match[1]));
  if (exports.length !== 1) return { ok: false, reason: "runtime-export-drift", text };
  const exportMatch = exports[0];
  const specifiers = exportMatch[1].split(",").map((value) => value.trim()).filter(Boolean);
  const defaults = specifiers.filter((value) => /\bas\s+default$/.test(value));
  if (defaults.length !== 1) return { ok: false, reason: "runtime-export-drift", text };
  const factoryMatch = /^([A-Za-z_$][\w$]*)\s+as\s+default$/.exec(defaults[0]);
  if (!factoryMatch) return { ok: false, reason: "runtime-export-drift", text };

  const sourceMapPattern = /^[ \t]*\/\/[#@]\s*sourceMappingURL=.*(?:\r?\n|$)/gm;
  if ([...text.matchAll(sourceMapPattern)].length !== 1) return { ok: false, reason: "runtime-source-map-drift", text };
  const runtimeBody = text.slice(importEnd, exportMatch.index);
  const staticImportPattern = /import\s*\{[^}]+\}\s*from\s*(?:"[^"]+"|'[^']+')\s*;/g;
  const bodyWithoutImports = runtimeBody.replace(staticImportPattern, "");
  if (/\bimport(?:\s|\{)/.test(bodyWithoutImports) || /\bexport\b/.test(runtimeBody)) return { ok: false, reason: "runtime-import-drift", text };
  const isolatedBody = bodyWithoutImports.replace(SENTINEL, "");
  if (isolatedBody === bodyWithoutImports) return { ok: false, reason: "runtime-sentinel-drift", text };

  const namedSpecifiers = specifiers.filter((value) => value !== defaults[0]);
  const namedExport = namedSpecifiers.length > 0 ? `export{${namedSpecifiers.join(",")}};` : "";
  const suffix = text.slice(exportMatch.index + exportMatch[0].length).replace(sourceMapPattern, "");
  const wrapperName = "__puiBackgroundTasksIsolatedDefault";
  const wrapper = `${RUNTIME_ISOLATION_SENTINEL}function ${wrapperName}(...args){const factory=(()=>{${isolatedBody};return ${factoryMatch[1]}})();return factory(...args)};`;
  return {
    ok: true,
    text: `${text.slice(0, exportMatch.index)}${wrapper}${namedExport}export{${wrapperName} as default};${suffix}`,
  };
}

function patchText(text) {
  if (text.includes(SENTINEL)) {
    return hasCompactMetadata(text)
      ? { patched: false, reason: "already-patched", text }
      : { patched: false, reason: "patched-metadata-drift", text };
  }
  if (countOccurrences(text, START_ANCHOR) !== 1) return { patched: false, reason: "anchor-missing", text };

  let next = text;
  for (const [oldValue, newValue, count] of replacementPlan()) {
    const result = replaceStringLiteral(next, oldValue, newValue, count);
    if (!result.ok) return { patched: false, reason: "metadata-drift", field: result.value, expected: result.expected, actual: result.actual, text };
    next = result.text;
  }
  for (const [name, original] of Object.entries(ORIGINAL_TOOL_METADATA)) {
    const targets = GUIDELINE_TARGETS[name];
    const expanded = targets.concat(Array(Math.max(0, original.guidelines.length - targets.length)).fill(""));
    const expandedArray = `promptGuidelines:${JSON.stringify(expanded)}`;
    if (countOccurrences(next, expandedArray) !== 1) return { patched: false, reason: "guideline-array-drift", field: name, text };
    next = next.replace(expandedArray, `promptGuidelines:${JSON.stringify(targets)}`);
  }
  next = next.replace(START_ANCHOR, `${SENTINEL}${START_ANCHOR}`);
  const isolated = isolateDefaultFactory(next);
  if (!isolated.ok) return { patched: false, reason: isolated.reason, text };
  next = isolated.text;
  if (!hasCompactMetadata(next)) return { patched: false, reason: "verification-failed", text };
  return { patched: true, text: next };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function defaultPackageDir() {
  return path.join(os.homedir(), ".pi", "agent", "npm", ...PATCH_CONFIG.packagePath.split("/"));
}

function bundleFile(packageDir = defaultPackageDir()) {
  return path.join(packageDir, PATCH_CONFIG.bundle);
}

function backupFile(packageDir = defaultPackageDir()) {
  return `${bundleFile(packageDir)}${PATCH_CONFIG.backupSuffix}`;
}

function manifestFile(packageDir = defaultPackageDir()) {
  return `${bundleFile(packageDir)}${PATCH_CONFIG.manifestSuffix}`;
}

function artifactFiles(packageDir = defaultPackageDir()) {
  return [bundleFile(packageDir), backupFile(packageDir), manifestFile(packageDir)];
}

function snapshotCore(state) {
  return {
    owner: state.owner,
    schemaVersion: state.schemaVersion,
    packageDir: state.packageDir,
    artifacts: state.artifacts,
  };
}

function snapshot(stateDir, packageDir = defaultPackageDir()) {
  const stateFile = path.join(stateDir, "state.json");
  if (fs.existsSync(stateFile)) return { ok: false, reason: "snapshot-exists", stateDir };
  fs.mkdirSync(stateDir, { recursive: true });
  const artifacts = artifactFiles(packageDir).map((file, index) => {
    const existed = fs.existsSync(file);
    const copy = `${index}.artifact`;
    let hash = null;
    if (existed) {
      const content = fs.readFileSync(file);
      fs.writeFileSync(path.join(stateDir, copy), content);
      hash = sha256(content);
    }
    return { existed, copy, hash };
  });
  const state = { owner: "PUI", schemaVersion: 1, packageDir: path.resolve(packageDir), artifacts };
  state.identityHash = sha256(JSON.stringify(snapshotCore(state)));
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { ok: true, stateDir };
}

function restoreSnapshot(stateDir, packageDir = defaultPackageDir()) {
  const stateFile = path.join(stateDir, "state.json");
  if (!fs.existsSync(stateFile)) return { ok: false, reason: "snapshot-missing", stateDir };
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (error) { return { ok: false, reason: "snapshot-invalid", error: error.message }; }
  const files = artifactFiles(packageDir);
  if (state.owner !== "PUI" || state.schemaVersion !== 1 || state.packageDir !== path.resolve(packageDir) || !Array.isArray(state.artifacts) || state.artifacts.length !== files.length || state.identityHash !== sha256(JSON.stringify(snapshotCore(state)))) {
    return { ok: false, reason: "snapshot-invalid" };
  }
  for (const [index, artifact] of state.artifacts.entries()) {
    const expectedCopy = `${index}.artifact`;
    if (artifact.copy !== expectedCopy || typeof artifact.existed !== "boolean") return { ok: false, reason: "snapshot-invalid" };
    if (artifact.existed) {
      const copy = path.join(stateDir, expectedCopy);
      if (!fs.existsSync(copy) || sha256(fs.readFileSync(copy)) !== artifact.hash) return { ok: false, reason: "snapshot-drift" };
    } else if (artifact.hash !== null || fs.existsSync(path.join(stateDir, expectedCopy))) {
      return { ok: false, reason: "snapshot-invalid" };
    }
  }
  for (const [index, artifact] of state.artifacts.entries()) {
    const file = files[index];
    if (artifact.existed) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(stateDir, artifact.copy), file);
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
  return { ok: true, stateDir };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function removeGuardOwner(ownerFile, transactionId, stateDir) {
  if (!ownerFile || !fs.existsSync(ownerFile)) return;
  const owner = readStatus(ownerFile);
  if (owner && owner.id === transactionId && owner.stateDir === path.resolve(stateDir)) fs.unlinkSync(ownerFile);
}

function resolveGuardSnapshot(stateDir, packageDir, restore, options = {}) {
  if (restore) {
    const restored = restoreSnapshot(stateDir, packageDir);
    if (!restored.ok) return { ok: false, reason: `guard-${restored.reason}`, stateDir };
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  removeGuardOwner(options.ownerFile, options.transactionId, stateDir);
  return { ok: true, action: restore ? "restored" : "committed" };
}

function guardSnapshot(stateDir, target, options = {}) {
  const packageDir = options.packageDir || defaultPackageDir();
  const statusFile = options.statusFile || UPDATE_STATUS_FILE;
  const lockFile = options.lockFile || UPDATE_LOCK_FILE;
  const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;
  const intervalMs = options.intervalMs ?? 250;
  const initial = readStatus(statusFile);
  if (!initial || typeof initial.id !== "string" || initial.target !== target || (options.transactionId && initial.id !== options.transactionId)) {
    return { ok: false, reason: "guard-status-mismatch" };
  }
  const resolve = (restore) => resolveGuardSnapshot(stateDir, packageDir, restore, {
    ownerFile: options.ownerFile,
    transactionId: initial.id,
  });
  fs.writeFileSync(path.join(stateDir, "guard-ready"), `${initial.id}\n`, "utf8");
  const deadline = Date.now() + timeoutMs;
  const graceMs = options.graceMs ?? 3000;
  let anomalySince = null;
  while (true) {
    const status = readStatus(statusFile);
    if (status && status.id === initial.id && status.result) return resolve(status.result !== "success");
    const lock = readStatus(lockFile);
    const locked = lock && lock.id === initial.id && Number.isInteger(lock.pid) && processIsRunning(lock.pid);
    if (locked) {
      anomalySince = null;
    } else {
      // A result write and lock release can race a poll; only treat a sustained
      // absence as worker death. The status check above keeps running through
      // the grace period, so an observed terminal result always wins.
      if (anomalySince === null) anomalySince = Date.now();
      else if (Date.now() - anomalySince > graceMs) return resolve(true);
    }
    if (Date.now() > deadline) return resolve(true);
    sleepMs(intervalMs);
  }
}

function processIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error && error.code === "EPERM"; }
}

function activeTransaction(scriptVersion, options = {}) {
  const lockFile = options.lockFile || UPDATE_LOCK_FILE;
  const statusFile = options.statusFile || UPDATE_STATUS_FILE;
  const lock = readStatus(lockFile);
  const status = readStatus(statusFile);
  if (!lock || !status || !Number.isInteger(lock.pid) || typeof lock.id !== "string" || lock.id !== status.id || !processIsRunning(lock.pid)) return null;
  if (status.result != null || typeof status.target !== "string") return null;
  const runsThisScript = typeof status.step === "string" ? status.step === scriptVersion : status.target === scriptVersion;
  return runsThisScript ? { id: status.id, target: status.target } : null;
}

function spawnGuard(stateDir, scriptVersion) {
  const transaction = activeTransaction(scriptVersion);
  if (!transaction) return { ok: true, action: "not-needed" };
  const existing = readStatus(UPDATE_GUARD_FILE);
  if (existing && existing.id === transaction.id && Number.isInteger(existing.pid) && processIsRunning(existing.pid)) {
    return { ok: true, action: "already-guarded", pid: existing.pid, target: transaction.target };
  }
  if (fs.existsSync(UPDATE_GUARD_FILE)) fs.unlinkSync(UPDATE_GUARD_FILE);
  const child = spawn(process.execPath, [__filename, "guard-snapshot", stateDir, transaction.target, UPDATE_GUARD_FILE, transaction.id], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
  if (!Number.isInteger(child.pid)) return { ok: false, reason: "guard-spawn-failed" };
  fs.writeFileSync(UPDATE_GUARD_FILE, `${JSON.stringify({ id: transaction.id, pid: child.pid, stateDir: path.resolve(stateDir) })}\n`, "utf8");
  return { ok: true, action: "guard-started", pid: child.pid, target: transaction.target };
}

function manifestCore(manifest) {
  return {
    owner: manifest.owner,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    schemaVersion: manifest.schemaVersion,
    bundle: manifest.bundle,
    originalHash: manifest.originalHash,
    patchedHash: manifest.patchedHash,
  };
}

function createOwnershipManifest(original, patched, schemaVersion = PATCH_CONFIG.schemaVersion) {
  const manifest = {
    owner: "PUI",
    packageName: PACKAGE_NAME,
    packageVersion: EXPECTED_VERSION,
    schemaVersion,
    bundle: PATCH_CONFIG.bundle,
    originalHash: sha256(original),
    patchedHash: sha256(patched),
  };
  manifest.identityHash = sha256(JSON.stringify(manifestCore(manifest)));
  return manifest;
}

function readOwnershipManifest(packageDir, options = {}) {
  const file = manifestFile(packageDir);
  if (!fs.existsSync(file)) return { ok: false, reason: "manifest-missing" };
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const expectedKeys = [...Object.keys(manifestCore(manifest)), "identityHash"].sort();
    if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys)) return { ok: false, reason: "invalid-manifest-shape" };
    if (manifest.owner !== "PUI" || manifest.packageName !== PACKAGE_NAME || manifest.bundle !== PATCH_CONFIG.bundle || (!options.allowStaleVersion && manifest.packageVersion !== EXPECTED_VERSION)) {
      return { ok: false, reason: "invalid-manifest-identity" };
    }
    if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 0 || manifest.identityHash !== sha256(JSON.stringify(manifestCore(manifest)))) {
      return { ok: false, reason: "invalid-manifest-hash" };
    }
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, reason: "invalid-manifest", error: error.message };
  }
}

function writeOwnershipManifest(packageDir, original, patched) {
  fs.writeFileSync(manifestFile(packageDir), `${JSON.stringify(createOwnershipManifest(original, patched), null, 2)}\n`, "utf8");
}

function readPackage(packageDir) {
  const packageFile = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageFile)) return { ok: false, reason: "package-missing" };
  try {
    const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    if (manifest.name !== PACKAGE_NAME) return { ok: false, reason: "package-name-mismatch", actual: manifest.name };
    if (manifest.version !== EXPECTED_VERSION) return { ok: false, reason: "version-mismatch", expected: EXPECTED_VERSION, actual: manifest.version };
    return { ok: true, version: manifest.version };
  } catch (error) {
    return { ok: false, reason: "invalid-package", error: error.message };
  }
}

function expectedFromBackup(packageDir) {
  const backup = backupFile(packageDir);
  if (!fs.existsSync(backup)) return { ok: false, reason: "backup-missing" };
  const original = fs.readFileSync(backup, "utf8");
  const transformed = patchText(original);
  if (!transformed.patched) return { ok: false, reason: "backup-invalid", detail: transformed.reason };
  return { ok: true, original, patched: transformed.text };
}

function apply(packageDir = defaultPackageDir()) {
  const packageResult = readPackage(packageDir);
  if (!packageResult.ok) return packageResult;
  const file = bundleFile(packageDir);
  const backup = backupFile(packageDir);
  const ownershipFile = manifestFile(packageDir);
  if (!fs.existsSync(file)) return { ok: false, reason: "bundle-missing", file };
  let current = fs.readFileSync(file, "utf8");
  const hasBackup = fs.existsSync(backup);
  const hasManifest = fs.existsSync(ownershipFile);

  if (!hasBackup && !hasManifest) {
    if (current.includes(SENTINEL)) return { ok: false, reason: "ownership-missing", file };
    const transformed = patchText(current);
    if (!transformed.patched) return { ok: false, reason: transformed.reason, field: transformed.field, file };
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, transformed.text, "utf8");
    writeOwnershipManifest(packageDir, current, transformed.text);
    return { ok: true, action: "patched", file };
  }

  if (!hasBackup) return { ok: false, reason: "backup-missing", file };

  if (hasManifest && !current.includes(SENTINEL)) {
    // The pinned upstream version changed and `pi install` replaced the bundle
    // while leaving PUI sidecars: rebase onto the pristine new-version bundle.
    const ownership = readOwnershipManifest(packageDir, { allowStaleVersion: true });
    if (ownership.ok && ownership.manifest.packageVersion !== packageResult.version) {
      const transformed = patchText(current);
      if (!transformed.patched) return { ok: false, reason: transformed.reason, field: transformed.field, file };
      fs.writeFileSync(backup, current, "utf8");
      fs.writeFileSync(file, transformed.text, "utf8");
      writeOwnershipManifest(packageDir, current, transformed.text);
      return { ok: true, action: "rebased", file };
    }
  }

  const expected = expectedFromBackup(packageDir);
  if (!expected.ok) return expected;

  if (!hasManifest) {
    if (current !== expected.original && current !== expected.patched) return { ok: false, reason: "incomplete-owned-shape", file };
    if (current !== expected.patched) fs.writeFileSync(file, expected.patched, "utf8");
    writeOwnershipManifest(packageDir, expected.original, expected.patched);
    return { ok: true, action: current === expected.patched ? "adopted" : "patched", file };
  }

  const ownership = readOwnershipManifest(packageDir);
  if (!ownership.ok) return ownership;
  if (sha256(expected.original) !== ownership.manifest.originalHash) return { ok: false, reason: "backup-hash-mismatch", file };
  const currentHash = sha256(current);
  const isOwnedPatch = currentHash === ownership.manifest.patchedHash;
  const isPristineReset = currentHash === ownership.manifest.originalHash;
  const isDesiredPatch = current === expected.patched;
  if (!isOwnedPatch && !isPristineReset && !isDesiredPatch) return { ok: false, reason: "installed-drift", file };

  const action = isDesiredPatch ? (isOwnedPatch ? "already-patched" : "adopted") : isPristineReset ? "patched" : "updated";
  if (current !== expected.patched) {
    fs.writeFileSync(file, expected.patched, "utf8");
    current = expected.patched;
  }
  writeOwnershipManifest(packageDir, expected.original, current);
  return { ok: true, action, file };
}

function verify(packageDir = defaultPackageDir()) {
  const packageResult = readPackage(packageDir);
  if (!packageResult.ok) return packageResult;
  const file = bundleFile(packageDir);
  if (!fs.existsSync(file)) return { ok: false, reason: "bundle-missing", file };
  const expected = expectedFromBackup(packageDir);
  if (!expected.ok) return expected;
  const ownership = readOwnershipManifest(packageDir);
  if (!ownership.ok) return ownership;
  const current = fs.readFileSync(file, "utf8");
  if (sha256(expected.original) !== ownership.manifest.originalHash || sha256(current) !== ownership.manifest.patchedHash || current !== expected.patched) {
    return { ok: false, reason: "installed-drift", file };
  }
  return { ok: true, file };
}

function remove(packageDir = defaultPackageDir()) {
  const file = bundleFile(packageDir);
  const backup = backupFile(packageDir);
  const ownershipFile = manifestFile(packageDir);
  const hasFile = fs.existsSync(file);
  const hasBackup = fs.existsSync(backup);
  const hasManifest = fs.existsSync(ownershipFile);
  if (!hasFile && !hasBackup && !hasManifest) return { ok: true, action: "absent" };
  if (hasFile && !hasBackup && !hasManifest && !fs.readFileSync(file, "utf8").includes(SENTINEL)) return { ok: true, action: "absent" };
  if (!hasFile || !hasBackup || !hasManifest) return { ok: false, action: "preserved", reason: "incomplete-owned-shape", file };

  const ownership = readOwnershipManifest(packageDir);
  if (!ownership.ok) return { ok: false, action: "preserved", reason: ownership.reason, file };
  const original = fs.readFileSync(backup, "utf8");
  const current = fs.readFileSync(file, "utf8");
  if (sha256(original) !== ownership.manifest.originalHash) return { ok: false, action: "preserved", reason: "backup-hash-mismatch", file };
  if (sha256(current) !== ownership.manifest.patchedHash && current !== original) return { ok: false, action: "preserved", reason: "modified", file };
  if (current !== original) fs.writeFileSync(file, original, "utf8");
  fs.unlinkSync(backup);
  fs.unlinkSync(ownershipFile);
  return { ok: true, action: "restored", file };
}

function main(argv) {
  const command = argv[0] || "apply";
  const dirIndex = argv.indexOf("--dir");
  const packageDir = dirIndex >= 0 ? argv[dirIndex + 1] : defaultPackageDir();
  let result;
  if (command === "apply") result = apply(packageDir);
  else if (command === "verify") result = verify(packageDir);
  else if (command === "remove") result = remove(packageDir);
  else if (command === "snapshot") result = snapshot(argv[1], packageDir);
  else if (command === "restore-snapshot") result = restoreSnapshot(argv[1], packageDir);
  else if (command === "guard-snapshot") result = guardSnapshot(argv[1], argv[2], { packageDir, ownerFile: argv[3], transactionId: argv[4] });
  else if (command === "spawn-guard") result = spawnGuard(argv[1], argv[2]);
  else {
    console.error("Usage: pui-background-tasks-patch.js [apply|verify|remove] [--dir <package-dir>] | <snapshot|restore-snapshot> <state-dir> [--dir <package-dir>] | <spawn-guard|guard-snapshot> <state-dir> <target-version>");
    return 64;
  }
  const output = JSON.stringify(result);
  if (result.ok) console.log(output);
  else console.error(output);
  if (command === "spawn-guard" && result.action === "not-needed") return 75;
  if (command === "spawn-guard" && result.action === "already-guarded") return 76;
  if (result.ok) return 0;
  return command === "remove" && result.action === "preserved" ? 2 : 1;
}

module.exports = {
  EXPECTED_VERSION,
  ORIGINAL_TOOL_METADATA,
  PARAMETER_REPLACEMENTS,
  PUI_GUIDELINES,
  PUI_TOOL_METADATA,
  RUNTIME_ISOLATION_SENTINEL,
  SENTINEL,
  activeTransaction,
  apply,
  backupFile,
  bundleFile,
  createOwnershipManifest,
  defaultPackageDir,
  guardSnapshot,
  manifestFile,
  patchText,
  remove,
  restoreSnapshot,
  snapshot,
  spawnGuard,
  verify,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
