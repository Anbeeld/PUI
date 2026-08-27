const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  patchText,
  patchCompletionText,
  patchCompletionCall,
  apply,
  verify,
  FN_START,
  NEW_FN,
  NEW_COMPLETION_METHOD,
  SENTINEL,
  COMPLETION_SENTINEL,
  ENTRY_SENTINEL,
} = require("../lib/pui-goal-patch.js");

// A minimal chunk fixture: the original formatStatus body followed by another
// function declaration, so the "\nfunction " end boundary resolves like the
// real bundle. Helpers are stubbed to the stable imported names the replacement
// calls (safeGoalMenuText, formatDuration, formatTokenCount, DEFAULT_GOAL_SETTINGS).
const ORIGINAL_FN =
  "function formatStatus(goal, automaticTurnLimit = DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns) {\n" +
  '  if (!goal) return void 0;\n' +
  '  if (goal.status === "complete") return "complete";\n' +
  '  const automatic = automaticTurnLimit === null ? "automatic Unlimited" : `automatic ${goal.automaticModelTurns}/${automaticTurnLimit}`;\n' +
  '  if (goal.status === "usage_limited") return `usage \\xB7 ${automatic}`;\n' +
  "  return `active ${formatDuration(goal.timeUsedSeconds)} \\xB7 ${automatic}`;\n" +
  "}\n\n";

function sampleChunk() {
  return (
    'var DEFAULT_GOAL_SETTINGS = { continuationLimits: { automaticTurns: 25 } };\n' +
    "function safeGoalMenuText(s) { return s; }\n" +
    "function formatDuration(s) { return s + \"s\"; }\n" +
    "function formatTokenCount(n) { return n >= 1000 ? (n / 1000) + \"k\" : String(n); }\n\n" +
    ORIGINAL_FN +
    "function formatBudget(goal) { return goal.tokensUsed + \"/\" + goal.tokenBudget; }\n"
  );
}

// Evaluate the replacement function with stubs for its module-scoped helpers,
// so the exact bytes written to the dist are tested for every goal state.
function makeFormatStatus() {
  const body = NEW_FN.replace(SENTINEL + "\n", "") + "\nreturn formatStatus;";
  return new Function(
    "safeGoalMenuText",
    "formatDuration",
    "formatTokenCount",
    "DEFAULT_GOAL_SETTINGS",
    body,
  )(
    (s) => s,
    (s) => `${s}s`,
    (n) => (n >= 1000 ? `${n / 1000}k` : String(n)),
    { continuationLimits: { automaticTurns: 25 } },
  );
}

function makeCompletionStatus() {
  const body = `return { ${NEW_COMPLETION_METHOD} };`;
  return new Function("formatDuration", "STATUS_KEY", "setTimeout", body)(
    (s) => `${s}s`,
    "goal",
    (callback, delay) => ({ callback, delay }),
  ).showCompletionStatus;
}

const ORIGINAL_COMPLETION_METHOD =
  "class GoalRuntime {\n" +
  "  showCompletionStatus(ctx) {\n" +
  "    this.clearCompletionStatusTimer();\n" +
  '    ctx.ui.setStatus(STATUS_KEY, "complete");\n' +
  "    this.completionStatusTimer = setTimeout(() => {\n" +
  "      this.completionStatusTimer = void 0;\n" +
  "      ctx.ui.setStatus(STATUS_KEY, void 0);\n" +
  "    }, 8e3);\n" +
  "  }\n" +
  "  clearCompletionStatusTimer() {}\n" +
  "}\n";

const ORIGINAL_COMPLETION_CALL =
  "      runtime.clearCompletedGoal(ctx);\n" +
  "      runtime.showCompletionStatus(ctx);\n";

test("patchText replaces the whole formatStatus function", () => {
  const result = patchText(sampleChunk());
  assert.equal(result.patched, true);
  assert.equal(result.text.includes(SENTINEL), true);
  assert.equal(result.text.includes('"automatic Unlimited"'), false);
  assert.equal(result.text.includes(FN_START), true);
  assert.equal(result.text.includes('"Goal: "'), true);
  assert.equal(result.text.includes('parts.join(" \\xB7 ")'), true);
  assert.equal(result.text.includes("function formatBudget(goal)"), true);
});

test("patchText is idempotent via the sentinel", () => {
  const first = patchText(sampleChunk());
  const second = patchText(first.text);
  assert.equal(second.patched, false);
  assert.equal(second.reason, "already-patched");
  assert.equal(second.text, first.text);
});

test("patchText fails fast when formatStatus is missing", () => {
  const result = patchText("function other() { return 1; }\n");
  assert.equal(result.patched, false);
  assert.equal(result.reason, "anchor-missing");
});

test("patchText fails fast when the end boundary is missing", () => {
  const text = "function formatStatus(goal, automaticTurnLimit = 25) { return void 0; }\n";
  assert.equal(patchText(text).patched, false);
});

test("patched function emits the approved status line for every state", () => {
  const f = makeFormatStatus();
  assert.equal(f(undefined), undefined);
  assert.equal(f({ status: "complete", timeUsedSeconds: 10 }), "Goal: complete \xB7 10s");
  assert.equal(
    f({ status: "active", timeUsedSeconds: 340, automaticModelTurns: 0 }, 25),
    "Goal: active \xB7 340s \xB7 0/25",
  );
  assert.equal(
    f({ status: "active", tokenBudget: 50000, tokensUsed: 12000, automaticModelTurns: 3 }, 25),
    "Goal: active \xB7 12k/50k \xB7 3/25",
  );
  assert.equal(
    f({ status: "usage_limited", automaticModelTurns: 0 }, 25),
    "Goal: paused \xB7 usage \xB7 0/25",
  );
  assert.equal(
    f({ status: "budget_limited", tokenBudget: 50000, tokensUsed: 50000 }, 25),
    "Goal: paused \xB7 budget 50k/50k",
  );
  assert.equal(
    f({ status: "paused", safetyPauseCause: "continuation_limit", automaticModelTurns: 25 }, 25),
    "Goal: paused \xB7 turn limit \xB7 25/25",
  );
  assert.equal(
    f({ status: "paused", safetyPauseCause: "no_progress", automaticModelTurns: 3 }, 25),
    "Goal: paused \xB7 no progress \xB7 3/25",
  );
  assert.equal(f({ status: "paused", automaticModelTurns: 0 }, 25), "Goal: paused \xB7 0/25");
  assert.equal(
    f({ status: "waiting", waiting: { reason: "external event" }, automaticModelTurns: 0 }, 25),
    "Goal: waiting \xB7 external event \xB7 0/25",
  );
  assert.equal(f({ status: "blocked", automaticModelTurns: 0 }, 25), "Goal: blocked \xB7 0/25");
  assert.equal(f({ status: "queued", automaticModelTurns: 0 }, 25), "Goal: queued \xB7 0/25");
});

test("completion status includes elapsed time and still clears upstream-style", () => {
  const showCompletionStatus = makeCompletionStatus();
  const statuses = [];
  const instance = {
    clearCompletionStatusTimer() {},
    completionStatusTimer: undefined,
  };
  showCompletionStatus.call(instance, {
    ui: { setStatus: (_key, value) => statuses.push(value) },
  }, 10);
  const timer = instance.completionStatusTimer;
  assert.deepEqual(statuses, ["Goal: complete \xB7 10s"]);
  assert.equal(timer.delay, 8e3);
  timer.callback();
  assert.deepEqual(statuses, ["Goal: complete \xB7 10s", undefined]);
});

test("completion method and call are patched independently and idempotently", () => {
  const method = patchCompletionText(ORIGINAL_COMPLETION_METHOD);
  assert.equal(method.patched, true);
  assert.match(method.text, new RegExp(COMPLETION_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(method.text, /formatDuration\(timeUsedSeconds\)/);
  assert.equal(patchCompletionText(method.text).reason, "already-patched");

  const call = patchCompletionCall(ORIGINAL_COMPLETION_CALL);
  assert.equal(call.patched, true);
  assert.match(call.text, new RegExp(ENTRY_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(call.text, /completionTimeUsedSeconds/);
  assert.match(call.text, /showCompletionStatus\(ctx, completionTimeUsedSeconds\)/);
  assert.equal(patchCompletionCall(call.text).reason, "already-patched");
});

test("patched function omits the counter when turns are unlimited", () => {
  const f = makeFormatStatus();
  assert.equal(f({ status: "active", timeUsedSeconds: 340 }, null), "Goal: active \xB7 340s");
  assert.equal(f({ status: "usage_limited", automaticModelTurns: 0 }, null), "Goal: paused \xB7 usage");
});

test("apply writes the patch and verify confirms it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-goal-test-"));
  fs.mkdirSync(path.join(tmp, "chunks"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "chunks", "chunk-AAAA1111.js"), sampleChunk() + ORIGINAL_COMPLETION_METHOD, "utf8");

  fs.writeFileSync(path.join(tmp, "index.ts"), ORIGINAL_COMPLETION_CALL, "utf8");

  const r = apply(tmp);
  assert.equal(r.ok, true);
  assert.equal(r.action, "patched");

  const v = verify(tmp);
  assert.equal(v.ok, true);

  const r2 = apply(tmp);
  assert.equal(r2.ok, true);
  assert.equal(r2.action, "already-patched");
});

test("apply and verify report missing entry when completion cannot be patched", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-goal-test-"));
  fs.mkdirSync(path.join(tmp, "chunks"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "chunks", "chunk-CCCC3333.js"), sampleChunk(), "utf8");

  assert.equal(apply(tmp).ok, false);
  assert.equal(verify(tmp).ok, false);
});

test("apply and verify report missing chunk when the dist has no formatStatus", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-goal-test-"));
  fs.mkdirSync(path.join(tmp, "chunks"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "chunks", "chunk-BBBB2222.js"), "function other() { return 1; }\n", "utf8");

  assert.equal(apply(tmp).ok, false);
  assert.equal(verify(tmp).ok, false);
});

test("apply reports no-chunk when the dist directory is absent", () => {
  assert.equal(apply(path.join(os.tmpdir(), "pui-goal-missing-" + process.pid)).ok, false);
});