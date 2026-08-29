const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const crypto = require("node:crypto");

const patchModule = () => require("../lib/pui-background-tasks-patch.js");

const ORIGINAL = {
  bg_start: {
    description: "Start a task asynchronously only when background execution is genuinely needed: for concurrent work, later interaction, or an explicit user request. Its unique name can immediately reference ordered follow-up bg_* calls in the same assistant response.",
    snippet: "Start a genuinely asynchronous task for concurrent work or later interaction",
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
    parameters: [
      "A short unique name for the task (case-insensitive among retained tasks)",
      "The shell command to run",
      "Working directory (defaults to current)",
      "Run in a pseudoterminal for interactive/TUI programs (default: false)",
      "Initial PTY columns (default: current terminal or 120)",
      "Initial PTY rows (default: current terminal or 30)",
    ],
  },
  bg_wait: {
    description: "Wait for a finite task to finish or time out and include its latest pipe log line when available. Use bg_logs for full pipe output or PTY terminal output.",
    snippet: "Wait for finite completion and return the latest pipe log line",
    guidelines: [
      "Use bg_wait once when completion of an already-justified finite bg_start task is required; never create a bg_start task solely so you can wait on it.",
      "bg_wait returns completion status plus the latest pipe log line when available. Emit bg_logs immediately after bg_wait only when full or multiline pipe output or PTY terminal output is needed; do not wait for the bg_wait result before emitting bg_logs.",
      "A bg_wait timeout leaves the task running and still returns the latest pipe log line; a following same-response bg_logs call reads fuller output retained at that point.",
      "Do not use bg_wait for persistent servers or watchers, and do not immediately wait again after a timeout unless the user asks you to keep waiting.",
    ],
    parameters: [
      "Task ID or unique name (case-insensitive)",
      "Maximum seconds to wait (default: 300)",
    ],
  },
  bg_status: {
    description: "Inspect task status and metadata or list current tasks, including each task's latest pipe log line when available. This is not a polling or waiting tool and does not return full or PTY output.",
    snippet: "Inspect background task status with the latest pipe log line",
    guidelines: [
      "Do not poll bg_status after bg_start; use bg_wait once when a finite task's final status is required.",
      "Use bg_status only for requested task metadata, recovering a missing task reference, or diagnosing task state.",
      "Use bg_status without id only when the task ID or name is unknown and a retained-task list is needed.",
      "bg_status includes the latest pipe log line when available; use bg_logs for full or multiline pipe output and for all PTY terminal output.",
    ],
    parameters: ["Task ID or unique name. If omitted, lists all retained tasks."],
  },
  bg_logs: {
    description: "Read retained pipe or PTY output when the latest pipe line returned by bg_wait or bg_status is insufficient. Place bg_logs after bg_wait in the same response when fuller final output is needed.",
    snippet: "Read full task output when a latest-line summary is insufficient",
    guidelines: [
      "Use bg_logs when you need more than the latest pipe log line returned by bg_wait or bg_status, or when you need any PTY terminal output.",
      "Use bg_logs with tail=N for recent output; omit stream to use the correct default for either pipe or PTY mode.",
      "Do not poll with bg_logs. When fuller finite output is needed, emit bg_wait followed by bg_logs in the same assistant response; source ordering makes bg_logs run after bg_wait.",
    ],
    parameters: [
      "Task ID or unique name (case-insensitive)",
      "Read last N lines (default: 100)",
      "Which stream (default: 'both'); use terminal for explicit PTY output",
      "Start from this line (0-indexed). Overrides tail.",
      "Max lines with from_line (default: 500)",
    ],
  },
  bg_send: {
    description: "Send text and terminal keys to a running task, or signal a running/disconnected adapter-owned task.",
    snippet: "Send a compact text/key input string or an OS signal to a background task",
    guidelines: [
      "Provide exactly one of bg_send input or signal. bg_send input is exact text; wrap every terminal key in an angle-bracket token such as <C-d>, <A-f>, <Space>, or <Up>, and escape a literal '<' as \\<.",
      "Use bg_send input for terminal keys; use bg_send signal only when an OS process signal is explicitly intended.",
      "For a pipe task, bg_send input=<C-d> or input=<EOF> closes stdin.",
      "When bg_send is followed by waiting or output inspection, emit bg_send → bg_wait → bg_logs together in one assistant response so same-task source ordering avoids extra model rounds.",
      "For a disconnected adapter task, bg_send input is unavailable because the local transport is gone, but bg_send signal may remain usable for cleanup.",
    ],
    parameters: [
      "Task ID or unique name (case-insensitive)",
      "Exact text; terminal keys must use <...> tokens, for example y<Enter>, <A-f>, or <C-d>",
      "Named signal validated against the task's local or adapter execution environment",
    ],
  },
  bg_kill: {
    description: "Terminate a running or disconnected background task and report the result. Sends SIGTERM by default or SIGKILL with force=true; does not return process output.",
    snippet: "Terminate an unresponsive background task",
    guidelines: [
      "Use bg_kill when a background task must be terminated.",
      "Use bg_kill with force=true to send SIGKILL immediately; otherwise bg_kill sends SIGTERM.",
      "bg_kill returns termination status only. When final output is needed, emit bg_kill followed by bg_logs in the same assistant response.",
    ],
    parameters: [
      "Task ID or unique name (case-insensitive)",
      "Send SIGKILL instead of SIGTERM (default: false)",
    ],
  },
};

const EXPECTED_GUIDELINES = [
  "Use bg_start only when the user requests background execution, the process must remain available for later interaction, or useful work can proceed concurrently. Otherwise, when the result is needed before continuing, use foreground bash with an appropriate timeout.",
  "Calls concerning the same task execute in source order; emit dependent bg_* calls in the same assistant response. Different tasks can run concurrently. For finite work, use bg_start → bg_wait and add bg_logs only when multiline pipe or PTY output is needed.",
  "Use bg_wait once when finite completion is needed. Do not use it for persistent servers or watchers, poll with bg_status or bg_logs, or wait again after a timeout unless the user asks. A timeout leaves the task running.",
  "Use bg_status only for requested metadata, diagnosis, or listing when the task reference is unknown. Treat a returned Environment as the task's fixed launch host and cwd; an SSH task stays on that target and cwd even if the active workspace changes.",
  "After bg_send, add bg_wait or bg_logs only when completion or fuller output is needed. After bg_kill, add bg_logs only when final output is needed.",
  "Running bg_start tasks survive ordinary agent runs but terminate on reload or shutdown. Finished tasks are retained only through the current run — or the next one when they finish while idle — so collect needed output in the current workflow.",
];

function fixtureBundle() {
  return `function register(pi){${Object.entries(ORIGINAL).map(([name, tool]) =>
    `pi.registerTool({name:${JSON.stringify(name)},description:${JSON.stringify(tool.description)},promptSnippet:${JSON.stringify(tool.snippet)},promptGuidelines:${JSON.stringify(tool.guidelines)},parameterDescriptions:${JSON.stringify(tool.parameters)}});`
  ).join("")}}`;
}

function makePackage(version = "2.1.1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-bg-patch-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@99percentpeople/pi-background-tasks", version }));
  fs.writeFileSync(path.join(dir, "index.min.js"), fixtureBundle(), "utf8");
  return dir;
}

test("patchText replaces the complete background-task model guidance", () => {
  const { patchText, PUI_GUIDELINES, PUI_TOOL_METADATA, SENTINEL } = patchModule();
  assert.deepEqual(PUI_GUIDELINES, EXPECTED_GUIDELINES);
  const result = patchText(fixtureBundle());
  assert.equal(result.patched, true);
  assert.match(result.text, new RegExp(SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const tool of Object.values(ORIGINAL)) {
    assert.equal(result.text.includes(tool.description), false);
    assert.equal(result.text.includes(tool.snippet), false);
    for (const guideline of tool.guidelines) assert.equal(result.text.includes(guideline), false);
  }
  for (const [name, metadata] of Object.entries(PUI_TOOL_METADATA)) {
    assert.equal(result.text.includes(metadata.description), true, `${name} description`);
    assert.equal(result.text.includes(metadata.promptSnippet), true, `${name} snippet`);
  }
  for (const guideline of EXPECTED_GUIDELINES) assert.equal(result.text.includes(guideline), true);
  const renderedGuidelineArrays = [...result.text.matchAll(/promptGuidelines:(\[[^\]]*\])/g)]
    .flatMap((match) => JSON.parse(match[1]));
  assert.deepEqual(renderedGuidelineArrays, EXPECTED_GUIDELINES);
});

test("patchText is idempotent and fails closed on metadata drift", () => {
  const { patchText } = patchModule();
  const first = patchText(fixtureBundle());
  assert.equal(first.patched, true);
  const second = patchText(first.text);
  assert.equal(second.patched, false);
  assert.equal(second.reason, "already-patched");
  const drifted = fixtureBundle().replace(ORIGINAL.bg_wait.description, "upstream changed");
  assert.equal(patchText(drifted).reason, "metadata-drift");
});

test("apply is version-anchored, records ownership, and verify checks exact output", (t) => {
  const { apply, verify, backupFile, manifestFile } = patchModule();
  const dir = makePackage();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = fs.readFileSync(path.join(dir, "index.min.js"), "utf8");
  assert.deepEqual(apply(dir).action, "patched");
  assert.equal(fs.readFileSync(backupFile(dir), "utf8"), original);
  const manifest = JSON.parse(fs.readFileSync(manifestFile(dir), "utf8"));
  assert.equal(manifest.owner, "PUI");
  assert.equal(manifest.packageVersion, "2.1.1");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(verify(dir).ok, true);
  assert.equal(apply(dir).action, "already-patched");

  fs.appendFileSync(path.join(dir, "index.min.js"), "\n// drift");
  assert.equal(verify(dir).ok, false);
});

test("apply migrates an older PUI-owned transform from the pristine backup", (t) => {
  const { apply, backupFile, createOwnershipManifest, manifestFile, PUI_TOOL_METADATA } = patchModule();
  const dir = makePackage();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  apply(dir);
  const file = path.join(dir, "index.min.js");
  const desired = fs.readFileSync(file, "utf8");
  const previous = desired.replace(PUI_TOOL_METADATA.bg_start.description, "Previous PUI-owned bg_start description");
  const original = fs.readFileSync(backupFile(dir), "utf8");
  fs.writeFileSync(file, previous, "utf8");
  fs.writeFileSync(manifestFile(dir), JSON.stringify(createOwnershipManifest(original, previous)), "utf8");

  assert.equal(apply(dir).action, "updated");
  assert.equal(fs.readFileSync(file, "utf8"), desired);
});

test("apply repairs ownership after an interrupted owned-transform migration", (t) => {
  const { apply, createOwnershipManifest, manifestFile, verify, PUI_TOOL_METADATA } = patchModule();
  const dir = makePackage();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  apply(dir);
  const file = path.join(dir, "index.min.js");
  const desired = fs.readFileSync(file, "utf8");
  const previous = desired.replace(PUI_TOOL_METADATA.bg_start.description, "Previous PUI-owned bg_start description");
  const original = fs.readFileSync(`${file}.pui-original`, "utf8");
  fs.writeFileSync(manifestFile(dir), JSON.stringify(createOwnershipManifest(original, previous)), "utf8");

  assert.equal(apply(dir).action, "adopted");
  assert.equal(verify(dir).ok, true);
});

test("apply rejects an unexpected package version", (t) => {
  const { apply } = patchModule();
  const dir = makePackage("2.1.2");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(apply(dir), { ok: false, reason: "version-mismatch", expected: "2.1.1", actual: "2.1.2" });
});

test("snapshot restoration reverses an introducing lifecycle patch", (t) => {
  const { apply, manifestFile, restoreSnapshot, snapshot, backupFile } = patchModule();
  const dir = makePackage();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-bg-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const original = fs.readFileSync(path.join(dir, "index.min.js"), "utf8");

  assert.equal(snapshot(stateDir, dir).ok, true);
  assert.equal(apply(dir).ok, true);
  assert.equal(restoreSnapshot(stateDir, dir).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "index.min.js"), "utf8"), original);
  assert.equal(fs.existsSync(backupFile(dir)), false);
  assert.equal(fs.existsSync(manifestFile(dir)), false);
});

test("guard discovery distinguishes direct staged runs and checkpoint targets", (t) => {
  const { activeTransaction } = patchModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-bg-active-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lockFile = path.join(dir, "lock.json");
  const statusFile = path.join(dir, "status.json");

  assert.equal(activeTransaction("1.1.2", { lockFile, statusFile }), null);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, id: "route-1" }));
  fs.writeFileSync(statusFile, JSON.stringify({ id: "route-1", target: "1.2.0", step: "1.1.2", phase: "restarting", result: null }));
  assert.deepEqual(activeTransaction("1.1.2", { lockFile, statusFile }), { id: "route-1", target: "1.2.0" });
  assert.equal(activeTransaction("1.1.3", { lockFile, statusFile }), null);
});

test("transaction guard restores the snapshot after outer rollback", (t) => {
  const { apply, guardSnapshot, snapshot } = patchModule();
  const dir = makePackage();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-bg-guard-"));
  const statusFile = path.join(stateDir, "status.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const original = fs.readFileSync(path.join(dir, "index.min.js"), "utf8");
  snapshot(stateDir, dir);
  apply(dir);
  fs.writeFileSync(statusFile, JSON.stringify({ id: "tx-1", target: "1.1.2", phase: "complete", result: "rolled-back" }));

  assert.equal(guardSnapshot(stateDir, "1.1.2", { packageDir: dir, statusFile, timeoutMs: 100 }).action, "restored");
  assert.equal(fs.readFileSync(path.join(dir, "index.min.js"), "utf8"), original);
});

test("transaction guard restores only after a sustained lock anomaly", (t) => {
  const { apply, guardSnapshot, snapshot } = patchModule();
  const dir = makePackage();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-bg-guard-"));
  const statusFile = path.join(stateDir, "status.json");
  const lockFile = path.join(stateDir, "absent.lock");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const original = fs.readFileSync(path.join(dir, "index.min.js"), "utf8");
  snapshot(stateDir, dir);
  apply(dir);
  fs.writeFileSync(statusFile, JSON.stringify({ id: "tx-3", target: "1.1.2", phase: "restarting", result: null }));

  const result = guardSnapshot(stateDir, "1.1.2", { packageDir: dir, statusFile, lockFile, graceMs: 10, intervalMs: 5, timeoutMs: 5000 });
  assert.equal(result.action, "restored");
  assert.equal(fs.readFileSync(path.join(dir, "index.min.js"), "utf8"), original);
  assert.equal(fs.existsSync(path.join(stateDir, "state.json")), false);
});

test("apply rebases stale sidecars when the upstream package version changes", (t) => {
  const { apply, createOwnershipManifest, manifestFile, backupFile, verify } = patchModule();
  const dir = makePackage();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  apply(dir);
  const file = path.join(dir, "index.min.js");
  const staleOriginal = fs.readFileSync(backupFile(dir), "utf8");
  const stalePatched = fs.readFileSync(file, "utf8");
  const staleManifest = createOwnershipManifest(staleOriginal, stalePatched);
  staleManifest.packageVersion = "2.0.0";
  const core = {
    owner: staleManifest.owner,
    packageName: staleManifest.packageName,
    packageVersion: staleManifest.packageVersion,
    schemaVersion: staleManifest.schemaVersion,
    bundle: staleManifest.bundle,
    originalHash: staleManifest.originalHash,
    patchedHash: staleManifest.patchedHash,
  };
  staleManifest.identityHash = crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");
  fs.writeFileSync(manifestFile(dir), JSON.stringify(staleManifest), "utf8");

  // Simulate pi upgrading the package: pristine new-version bundle, stale sidecars.
  fs.writeFileSync(file, fixtureBundle(), "utf8");
  const result = apply(dir);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.action, "rebased");
  assert.equal(verify(dir).ok, true);
  assert.equal(fs.readFileSync(backupFile(dir), "utf8").includes("Start a genuinely asynchronous task"), true);
  assert.equal(fs.readFileSync(file, "utf8"), stalePatched);
});

test("transaction guard retains the patch after outer success", (t) => {
  const { apply, guardSnapshot, snapshot, verify } = patchModule();
  const dir = makePackage();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pui-bg-guard-"));
  const statusFile = path.join(stateDir, "status.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  snapshot(stateDir, dir);
  apply(dir);
  fs.writeFileSync(statusFile, JSON.stringify({ id: "tx-2", target: "1.1.2", phase: "complete", result: "success" }));

  assert.equal(guardSnapshot(stateDir, "1.1.2", { packageDir: dir, statusFile, timeoutMs: 100 }).action, "committed");
  assert.equal(verify(dir).ok, true);
});

test("remove treats an unpatched package as absent", (t) => {
  const { remove } = patchModule();
  const dir = makePackage();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(remove(dir), { ok: true, action: "absent" });
});

test("remove restores only an unmodified PUI-owned patch", (t) => {
  const { apply, remove, backupFile, manifestFile } = patchModule();
  const clean = makePackage();
  const modified = makePackage();
  t.after(() => fs.rmSync(clean, { recursive: true, force: true }));
  t.after(() => fs.rmSync(modified, { recursive: true, force: true }));

  const original = fs.readFileSync(path.join(clean, "index.min.js"), "utf8");
  apply(clean);
  assert.deepEqual(remove(clean), { ok: true, action: "restored", file: path.join(clean, "index.min.js") });
  assert.equal(fs.readFileSync(path.join(clean, "index.min.js"), "utf8"), original);
  assert.equal(fs.existsSync(backupFile(clean)), false);
  assert.equal(fs.existsSync(manifestFile(clean)), false);

  apply(modified);
  fs.appendFileSync(path.join(modified, "index.min.js"), "\n// user change");
  assert.deepEqual(remove(modified).action, "preserved");
  assert.equal(fs.existsSync(backupFile(modified)), true);
  assert.equal(fs.existsSync(manifestFile(modified)), true);
});
