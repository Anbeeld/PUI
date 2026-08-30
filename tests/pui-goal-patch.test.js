const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  patchText,
  patchCompletionText,
  patchCompletionCall,
  patchCompletionDisplay,
  patchCompletionLimit,
  patchCompletionPrompt,
  patchCommandParser,
  apply,
  verify,
  FN_START,
  NEW_FN,
  NEW_COMPLETION_METHOD,
  SENTINEL,
  COMPLETION_SENTINEL,
  ENTRY_SENTINEL,
  COMMAND_SENTINEL,
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

const ORIGINAL_COMPLETION_PROMPT =
  "function goalCompletionGuardBlock(goal) {\n" +
  "  return `This goal_id is only the goal_complete tool stale-turn guard, not part of the objective. If and only if the goal is fully complete, pass this exact goal_id to goal_complete with the completion summary.`;\n" +
  "}\n" +
  "function goalModeRules(goalLabel) {\n" +
  "  return [\n" +
  "    `- Only call the goal_complete tool after evidence proves every requirement of ${goalLabel} is satisfied and no required work remains. Pass this exact goal_id and never reuse an id from an older, stopped, replaced, or cleared turn.`\n" +
  "  ];\n" +
  "}\n";

const ORIGINAL_COMPLETION_LIMIT =
  "var MAX_GOAL_TEXT_LENGTH = 4e3;\n" +
  "var MAX_COMPLETION_SUMMARY_LENGTH = 4e3;\n" +
  "var MAX_BLOCKER_REASON_LENGTH = 1e3;\n" +
  "      summary: Type.String({\n" +
  "        minLength: 1,\n" +
  "        maxLength: MAX_COMPLETION_SUMMARY_LENGTH,\n" +
  '        description: "Provide the complete final response that should be shown to the user when the Goal finishes. Include every user-facing deliverable required by the objective and concise verification evidence where relevant. Do not report partial work, remaining work, or promise to deliver content in a later message."\n' +
  "      })\n" +
  '      const summary = typeof params.summary === "string" ? params.summary.trim() : "";\n' +
  '      const rejectionReason = !summary ? "summary is empty" : summary.length > MAX_COMPLETION_SUMMARY_LENGTH ? "summary is too long" : isContradictoryCompletionSummary(summary) ? "summary says the goal is not complete" : void 0;\n' +
  "function completionDetails(goal2, goalId, summary) {\n" +
  "  return {\n" +
  "    goal: goal2.slice(0, MAX_GOAL_TEXT_LENGTH),\n" +
  "    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),\n" +
  "    summary: summary.slice(0, MAX_COMPLETION_SUMMARY_LENGTH)\n" +
  "  };\n" +
  "}\n";

const ORIGINAL_COMMAND_PARSER = `function parseCommand(args) {
  const tokens = tokenize(args.trim());
  if (tokens.length === 0) return { kind: "show" };
  const [first, ...rest] = tokens;
  if (first === "pause") return rest.length === 0 ? { kind: "pause" } : "Usage: /goal pause";
  if (first === "resume") return rest.length === 0 ? { kind: "resume" } : "Usage: /goal resume";
  if (first === "clear" || first === "stop") return rest.length === 0 ? { kind: "clear" } : "Usage: /goal clear";
  if (first === "status") return rest.length === 0 ? { kind: "show" } : "Usage: /goal status";
  if (first === "edit") return parseObjective("edit", rest);
  return parseObjective("start", tokens);
}
function isRemovedQueueCommand(args) {
  const [first] = tokenize(args.trim());
  return first !== void 0 && REMOVED_QUEUE_COMMANDS.has(first);
}
function parseObjective(kind, tokens) {
  let tokenBudget;
  const objectiveTokens = [...tokens];
  if (objectiveTokens[0] === "--tokens") {
    const rawBudget = objectiveTokens[1];
    if (!rawBudget) return "usage";
    const parsedBudget = parseTokenBudget(rawBudget);
    if (parsedBudget === void 0) return "invalid";
    tokenBudget = parsedBudget;
    objectiveTokens.splice(0, 2);
  }
  if (objectiveTokens.length === 0) return "usage";
  return { kind, objective: objectiveTokens.join(" "), tokenBudget };
}
function tokenize(input) {
  const tokens = [];
  let current = "";
  let quote;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = void 0;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}
function parseTokenBudget(value) {
  const match = /^(\\d+)(k)?$/i.exec(value);
  return match ? Number(match[1]) * (match[2] ? 1000 : 1) : void 0;
}
const REMOVED_QUEUE_COMMANDS = new Set(["add"]);
`;

const ORIGINAL_COMPLETION_DISPLAY =
  '    description: "Mark an active /goal complete only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and every requirement is verified. Tool visibility alone does not activate Goal mode. Never call for ordinary work, partial progress, blockers, failures, or unverified work.",\n' +
  '  pi.on("turn_end", (event, ctx) => {\n' +
  "    runtime.recordAutomaticTurn(ctx, event.message);\n" +
  '    if (runtime.activeGoal?.status !== "active") {\n' +
  "      runtime.ensureInactiveGoalContextContract(ctx);\n" +
  "    }\n" +
  "  });\n" +
  '  pi.on("agent_end", (event, ctx) => {};\n' +
  '        description: "State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work."\n';

test("command parser preserves initial objective formatting without changing command semantics", () => {
  const result = patchCommandParser(ORIGINAL_COMMAND_PARSER);
  assert.equal(result.patched, true);
  assert.match(result.text, new RegExp(COMMAND_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const parseCommand = new Function(`${result.text}\nreturn parseCommand;`)();

  assert.deepEqual(parseCommand("build release\n\n- first\n  - nested"), {
    kind: "start",
    objective: "build release\n\n- first\n  - nested",
    tokenBudget: undefined,
  });
  assert.deepEqual(parseCommand('  --tokens 100k   "ship  tests"\n\nthen deploy  '), {
    kind: "start",
    objective: "ship  tests\n\nthen deploy",
    tokenBudget: 100000,
  });
  assert.deepEqual(parseCommand("resume"), { kind: "resume" });
  assert.deepEqual(parseCommand("edit   collapse   remains"), {
    kind: "edit",
    objective: "collapse remains",
    tokenBudget: undefined,
  });
  assert.equal(patchCommandParser(result.text).reason, "already-patched");
});

test("command parser patch fails closed when the exact parser seam drifts", () => {
  const result = patchCommandParser(ORIGINAL_COMMAND_PARSER.replace('objectiveTokens.join(" ")', 'objectiveTokens.join("-")'));
  assert.equal(result.patched, false);
  assert.equal(result.reason, "anchor-missing");
});

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

test("completion prompt makes summary the complete user-visible result", () => {
  const result = patchCompletionPrompt(ORIGINAL_COMPLETION_PROMPT);
  assert.equal(result.patched, true);
  assert.match(result.text, /complete final response that should be shown to the user/);
  assert.match(result.text, /Include every user-facing deliverable required by the objective/);
  assert.match(result.text, /Call goal_complete alone as the final action/);
  assert.match(result.text, /do not promise to deliver content in a later message/i);
  assert.equal(patchCompletionPrompt(result.text).reason, "already-patched");
});

test("completion display promotes only an accepted summary after the inactive contract", () => {
  const result = patchCompletionDisplay(ORIGINAL_COMPLETION_DISPLAY);
  assert.equal(result.patched, true);
  assert.match(result.text, /runtime\.ensureInactiveGoalContextContract\(ctx\);[\s\S]*pi\.sendMessage\(/);
  assert.match(result.text, /customType: "Goal complete"/);
  assert.match(result.text, /content: completionSummary/);
  assert.match(result.text, /display: true/);
  assert.match(result.text, /triggerTurn: false/);
  assert.match(result.text, /result\.toolName === GOAL_COMPLETE_TOOL/);
  assert.match(result.text, /text === `Goal complete: \$\{summary\}`/);
  assert.match(result.text, /Call it alone as the final action/);
  assert.match(result.text, /complete final response that should be shown to the user/);
  assert.equal(patchCompletionDisplay(result.text).reason, "already-patched");
});

test("completion limit uses only Pi's 50 KB UTF-8 boundary", () => {
  const result = patchCompletionLimit(ORIGINAL_COMPLETION_LIMIT);
  assert.equal(result.patched, true);
  assert.doesNotMatch(result.text, /MAX_COMPLETION_SUMMARY_LENGTH/);
  assert.doesNotMatch(result.text, /maxLength:/);
  assert.doesNotMatch(result.text, /summary\.slice/);
  assert.match(result.text, /Buffer\.byteLength\(summary, "utf8"\)/);
  assert.match(result.text, /summaryBytes > DEFAULT_MAX_BYTES/);
  assert.match(result.text, /summary exceeds the 50 KB UTF-8 limit/);
  assert.match(result.text, /UTF-8 encoded response must not exceed 50 KB/);
  assert.match(result.text, /summary\n/);
  assert.equal(patchCompletionLimit(result.text).reason, "already-patched");
});

test("completion byte validation accepts the boundary and rejects one byte over", () => {
  const patched = patchCompletionLimit(ORIGINAL_COMPLETION_LIMIT).text;
  const start = patched.indexOf("      const summaryBytes");
  const end = patched.indexOf("\nfunction completionDetails");
  const validationSource = `${patched.slice(start, end)}\n      return rejectionReason;`;
  const validate = new Function("summary", "DEFAULT_MAX_BYTES", "isContradictoryCompletionSummary", validationSource);
  const check = (summary) => validate(summary, 50 * 1024, () => false);

  assert.equal(check("a".repeat(50 * 1024)), undefined);
  assert.equal(check("a".repeat(50 * 1024 + 1)), "summary exceeds the 50 KB UTF-8 limit");
  assert.equal(check("猫".repeat(Math.floor((50 * 1024) / 3))), undefined);
  assert.equal(check("猫".repeat(Math.floor((50 * 1024) / 3) + 1)), "summary exceeds the 50 KB UTF-8 limit");
});

test("completion prompt and display transforms fail closed on upstream drift", () => {
  assert.equal(patchCompletionPrompt(ORIGINAL_COMPLETION_PROMPT.replace("completion summary", "final summary")).reason, "guard-anchor-missing");
  assert.equal(patchCompletionDisplay(ORIGINAL_COMPLETION_DISPLAY.replace("turn_end", "turn_finish")).reason, "turn-end-anchor-missing");
  assert.equal(patchCompletionDisplay(ORIGINAL_COMPLETION_DISPLAY.replace("State what was completed", "Summarize completion")).reason, "description-anchor-missing");
  assert.equal(patchCompletionLimit(ORIGINAL_COMPLETION_LIMIT.replace("summary.length", "summary.size")).reason, "validation-anchor-missing");
});

test("completion display emits one durable visible card only for an accepted result", () => {
  const patched = patchCompletionDisplay(ORIGINAL_COMPLETION_DISPLAY).text;
  const handlerSource = patched
    .slice(patched.indexOf('  pi.on("turn_end"'), patched.indexOf('  pi.on("agent_end"'));
  let turnEnd;
  const events = [];
  const pi = {
    on(name, handler) {
      if (name === "turn_end") turnEnd = handler;
    },
    sendMessage(message, options) {
      events.push({ kind: "message", message, options });
    },
  };
  const runtime = {
    activeGoal: undefined,
    recordAutomaticTurn() {},
    ensureInactiveGoalContextContract() {
      events.push({ kind: "inactive-contract" });
    },
  };
  new Function("pi", "runtime", "GOAL_COMPLETE_TOOL", handlerSource)(pi, runtime, "goal_complete");

  turnEnd({
    message: {},
    toolResults: [{
      toolName: "goal_complete",
      isError: false,
      content: [{ type: "text", text: "Goal completion rejected: stale goal." }],
      details: { summary: "A result" },
    }],
  }, {});
  assert.deepEqual(events, [{ kind: "inactive-contract" }]);

  events.length = 0;
  turnEnd({
    message: {},
    toolResults: [{
      toolName: "goal_complete",
      isError: false,
      content: [{ type: "text", text: "Goal complete: The complete story." }],
      details: { summary: "The complete story." },
    }],
  }, {});
  assert.deepEqual(events, [
    { kind: "inactive-contract" },
    {
      kind: "message",
      message: { customType: "Goal complete", content: "The complete story.", display: true },
      options: { triggerTurn: false },
    },
  ]);
});

test("patched function omits the counter when turns are unlimited", () => {
  const f = makeFormatStatus();
  assert.equal(f({ status: "active", timeUsedSeconds: 340 }, null), "Goal: active \xB7 340s");
  assert.equal(f({ status: "usage_limited", automaticModelTurns: 0 }, null), "Goal: paused \xB7 usage");
});

test("apply writes the patch and verify confirms it", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-goal-test-"));
  fs.mkdirSync(path.join(tmp, "chunks"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "chunks", "chunk-AAAA1111.js"),
    sampleChunk() + ORIGINAL_COMPLETION_METHOD + ORIGINAL_COMPLETION_PROMPT + ORIGINAL_COMMAND_PARSER,
    "utf8",
  );

  fs.writeFileSync(
    path.join(tmp, "index.ts"),
    ORIGINAL_COMPLETION_LIMIT + ORIGINAL_COMPLETION_DISPLAY + ORIGINAL_COMPLETION_CALL,
    "utf8",
  );

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