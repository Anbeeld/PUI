#!/usr/bin/env node
// PUI-managed, idempotent patch for the installed @narumitw/pi-goal dist.
//
// PUI sets continuationLimits.automaticTurns = null (unlimited automatic /goal
// turns) via pi-goal.json. pi-goal's formatStatus emits a terse, unclear status
// line ("usage · automatic 0/25") that conflates the goal state and its reason.
// This patch replaces the entire formatStatus function with a structured,
// readable implementation: "Goal: <status> · <reason> · <counter>", where the
// counter is omitted entirely when turns are unlimited. It also patches the
// completion path because upstream clears the goal before its completion-status
// timer; elapsed time is captured before that clear and the timer is preserved.
//
// Robustness: the replacement calls only cross-chunk imported helpers
// (safeGoalMenuText, formatDuration, formatTokenCount, DEFAULT_GOAL_SETTINGS)
// whose names esbuild preserves; it never calls same-chunk local helpers like
// formatBudget, which the bundler minifies (formatBudget -> formatBudget2).
// The end boundary is the next "function " declaration after formatStatus, so a
// minified neighbor name cannot break the match.
//
// The patch is version-anchored and fails fast: if the formatStatus start or
// the following function boundary is missing, it reports drift instead of
// silently shipping an unpatched bar. A sentinel comment marks an
// already-patched file for idempotency. Install and update re-apply it after
// every `pi install @narumitw/pi-goal`, which reinstalls the dist.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const FN_START = "function formatStatus(goal, automaticTurnLimit";
const END_BOUNDARY = "\nfunction ";
const SENTINEL = "/* pui-goal-patch:structured-status */";
const COMPLETION_FN_START = "showCompletionStatus(ctx)";
const COMPLETION_FN_END = "\n  clearCompletionStatusTimer()";
const COMPLETION_SENTINEL = "/* pui-goal-patch:completion-status */";
const ENTRY_SENTINEL = "/* pui-goal-patch:completion-call */";
const FORMAT_COMPLETE_LINE = '  if (goal.status === "complete") return "Goal: complete \\xB7 " + formatDuration(goal.timeUsedSeconds);';
const COMPLETION_CALL = "      runtime.clearCompletedGoal(ctx);\n      runtime.showCompletionStatus(ctx);";

// The replacement function. Built as joined lines (no template interpolation,
// no source indentation bleed) so the exact bytes written are unambiguous. It
// reuses the cross-chunk imported helpers that the original formatStatus calls.
const NEW_FN = [
  SENTINEL,
  "function formatStatus(goal, automaticTurnLimit = DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns) {",
  "  if (!goal) return void 0;",
  FORMAT_COMPLETE_LINE,
  '  var counter = automaticTurnLimit === null ? "" : (goal.automaticModelTurns + "/" + automaticTurnLimit);',
  "  var parts = [];",
  '  if (goal.status === "queued") parts.push("Goal: queued");',
  '  else if (goal.waiting) parts.push("Goal: waiting");',
  '  else if (goal.status === "usage_limited" || goal.status === "budget_limited" || goal.status === "paused") parts.push("Goal: paused");',
  '  else parts.push("Goal: " + goal.status);',
  "  if (goal.waiting) parts.push(safeGoalMenuText(goal.waiting.reason));",
  '  else if (goal.status === "usage_limited") parts.push("usage");',
  '  else if (goal.status === "budget_limited") parts.push("budget " + formatTokenCount(goal.tokensUsed) + "/" + formatTokenCount(goal.tokenBudget ?? 0));',
  '  else if (goal.status === "paused" && goal.safetyPauseCause === "continuation_limit") parts.push("turn limit");',
  '  else if (goal.status === "paused" && goal.safetyPauseCause === "no_progress") parts.push("no progress");',
  '  else if (goal.status === "active" && goal.tokenBudget !== undefined) parts.push(formatTokenCount(goal.tokensUsed) + "/" + formatTokenCount(goal.tokenBudget ?? 0));',
  '  else if (goal.status === "active") parts.push(formatDuration(goal.timeUsedSeconds));',
  '  if (counter && goal.status !== "budget_limited") parts.push(counter);',
  '  return parts.join(" \\xB7 ");',
  "}",
].join("\n");

// The upstream completion tool clears the goal and then calls this method, so
// the elapsed time must be captured at the call site before the clear. The
// timer and its eight-second lifetime intentionally remain upstream-compatible.
const NEW_COMPLETION_METHOD = [
  COMPLETION_SENTINEL,
  "showCompletionStatus(ctx, timeUsedSeconds = 0) {",
  "  this.clearCompletionStatusTimer();",
  '  ctx.ui.setStatus(STATUS_KEY, "Goal: complete \\xB7 " + formatDuration(timeUsedSeconds));',
  "  this.completionStatusTimer = setTimeout(() => {",
  "    this.completionStatusTimer = void 0;",
  "    try {",
  "      ctx.ui.setStatus(STATUS_KEY, void 0);",
  "    } catch {",
  "    }",
  "  }, 8e3);",
  "}",
].join("\n");

const NEW_COMPLETION_CALL = [
  ENTRY_SENTINEL,
  "      const completionTimeUsedSeconds = runtime.activeGoal.timeUsedSeconds;",
  "      runtime.clearCompletedGoal(ctx);",
  "      runtime.showCompletionStatus(ctx, completionTimeUsedSeconds);",
].join("\n");

function defaultGoalDist() {
  return path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@narumitw", "pi-goal", "dist");
}

function findChunkFile(distDir) {
  const chunksDir = path.join(distDir, "chunks");
  if (!fs.existsSync(chunksDir)) return undefined;
  for (const name of fs.readdirSync(chunksDir)) {
    if (!/\.(js|ts)$/i.test(name)) continue;
    const file = path.join(chunksDir, name);
    try {
      const text = fs.readFileSync(file, "utf8");
      if (text.includes(FN_START) || text.includes(SENTINEL)) return { file, text };
    } catch {
      // Skip unreadable chunk files; the anchor is matched on readable text only.
    }
  }
  return undefined;
}

// Pure transform over the chunk source text. Returns:
//   { patched: true,  text }                            — function replaced
//   { patched: false, reason: "already-patched", text }  — current sentinel present
//   { patched: false, reason: "anchor-missing", text }   — formatStatus not found
//   { patched: false, reason: "end-boundary-missing", text } — no following function
function patchText(text) {
  const startIdx = text.indexOf(FN_START);
  if (startIdx === -1) return { patched: false, reason: "anchor-missing", text };
  const endIdx = text.indexOf(END_BOUNDARY, startIdx + FN_START.length);
  if (endIdx === -1) return { patched: false, reason: "end-boundary-missing", text };
  const sentinelIdx = text.lastIndexOf(SENTINEL, startIdx);
  const replacementStart = sentinelIdx >= startIdx - SENTINEL.length - 2 ? sentinelIdx : startIdx;
  if (text.startsWith(NEW_FN, replacementStart)) {
    return { patched: false, reason: "already-patched", text };
  }
  const next = text.slice(0, replacementStart) + NEW_FN + "\n\n" + text.slice(endIdx + 1);
  return { patched: true, text: next };
}

function patchCompletionText(text) {
  if (text.includes(COMPLETION_SENTINEL)) return { patched: false, reason: "already-patched", text };
  const startIdx = text.indexOf(COMPLETION_FN_START);
  if (startIdx === -1) return { patched: false, reason: "anchor-missing", text };
  const endIdx = text.indexOf(COMPLETION_FN_END, startIdx + COMPLETION_FN_START.length);
  if (endIdx === -1) return { patched: false, reason: "end-boundary-missing", text };
  const next = text.slice(0, startIdx) + NEW_COMPLETION_METHOD + text.slice(endIdx);
  return { patched: true, text: next };
}

function patchCompletionCall(text) {
  if (text.includes(ENTRY_SENTINEL)) return { patched: false, reason: "already-patched", text };
  const startIdx = text.indexOf(COMPLETION_CALL);
  if (startIdx === -1) return { patched: false, reason: "anchor-missing", text };
  const next = text.slice(0, startIdx) + NEW_COMPLETION_CALL + text.slice(startIdx + COMPLETION_CALL.length);
  return { patched: true, text: next };
}

function findEntryFile(distDir) {
  const file = path.join(distDir, "index.ts");
  if (!fs.existsSync(file)) return undefined;
  try {
    return { file, text: fs.readFileSync(file, "utf8") };
  } catch {
    return undefined;
  }
}

function apply(distDir = defaultGoalDist()) {
  const found = findChunkFile(distDir);
  if (!found) return { ok: false, reason: "no-chunk" };
  const entry = findEntryFile(distDir);
  if (!entry) return { ok: false, reason: "no-entry", file: found.file };

  const formatResult = patchText(found.text);
  if (!formatResult.patched && formatResult.reason !== "already-patched") {
    return { ok: false, reason: formatResult.reason, file: found.file };
  }
  const completionResult = patchCompletionText(formatResult.text);
  if (!completionResult.patched && completionResult.reason !== "already-patched") {
    return { ok: false, reason: `completion-${completionResult.reason}`, file: found.file };
  }
  const callResult = patchCompletionCall(entry.text);
  if (!callResult.patched && callResult.reason !== "already-patched") {
    return { ok: false, reason: `completion-call-${callResult.reason}`, file: entry.file };
  }

  if (formatResult.patched || completionResult.patched) fs.writeFileSync(found.file, completionResult.text, "utf8");
  if (callResult.patched) fs.writeFileSync(entry.file, callResult.text, "utf8");
  return {
    ok: true,
    action: formatResult.patched || completionResult.patched || callResult.patched ? "patched" : "already-patched",
    file: found.file,
    entry: entry.file,
  };
}

function verify(distDir = defaultGoalDist()) {
  const found = findChunkFile(distDir);
  if (!found) return { ok: false, reason: "no-chunk" };
  const entry = findEntryFile(distDir);
  if (!entry) return { ok: false, reason: "no-entry", file: found.file };
  const formatReady = found.text.includes(SENTINEL) && found.text.includes(FORMAT_COMPLETE_LINE);
  if (!formatReady) return { ok: false, reason: "format-outdated", file: found.file, entry: entry.file };
  if (!found.text.includes(COMPLETION_SENTINEL)) return { ok: false, reason: "completion-method-missing", file: found.file, entry: entry.file };
  if (!entry.text.includes(ENTRY_SENTINEL)) return { ok: false, reason: "completion-call-missing", file: found.file, entry: entry.file };
  return { ok: true, file: found.file, entry: entry.file };
}

function main(argv) {
  const command = argv[0] || "apply";
  const dirIndex = argv.indexOf("--dir");
  const distDir = dirIndex >= 0 ? argv[dirIndex + 1] : defaultGoalDist();
  if (command === "apply") {
    const r = apply(distDir);
    if (r.ok) {
      console.log(JSON.stringify(r));
      return 0;
    }
    console.error(`pi-goal status patch skipped: ${r.reason} (file: ${r.file || "none"})`);
    return 1;
  }
  if (command === "verify") {
    const r = verify(distDir);
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  }
  console.error("Usage: pui-goal-patch.js [apply|verify] [--dir <pi-goal dist>]");
  return 64;
}

module.exports = {
  patchText,
  patchCompletionText,
  patchCompletionCall,
  apply,
  verify,
  findChunkFile,
  findEntryFile,
  defaultGoalDist,
  FN_START,
  END_BOUNDARY,
  NEW_FN,
  NEW_COMPLETION_METHOD,
  COMPLETION_SENTINEL,
  ENTRY_SENTINEL,
  SENTINEL,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));