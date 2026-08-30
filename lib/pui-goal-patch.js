#!/usr/bin/env node
// PUI-managed, idempotent patch for the installed @narumitw/pi-goal dist.
//
// PUI sets continuationLimits.automaticTurns = null (unlimited automatic /goal
// turns) via pi-goal.json. pi-goal's formatStatus emits a terse, unclear status
// line ("usage · automatic 0/25") that conflates the goal state and its reason.
// This patch replaces the entire formatStatus function with a structured,
// readable implementation: "Goal: <status> · <reason> · <counter>", where the
// counter is omitted entirely when turns are unlimited. It preserves internal
// whitespace in new start objectives instead of rebuilding parsed tokens with
// one space, while retaining upstream subcommand, budget, quote, and edit
// behavior. It also patches the completion path because upstream clears the
// goal before its completion-status
// timer; elapsed time is captured before that clear and the timer is preserved.
// Successful goal_complete summaries are also defined as the complete
// user-visible response and promoted after the real tool result and hidden
// inactive contract are persisted. The visible custom message does not trigger
// another model turn, while the original tool call remains in process details.
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
const PROMPT_SENTINEL = "/* pui-goal-patch:visible-completion-prompt */";
const DISPLAY_SENTINEL = "/* pui-goal-patch:visible-completion-message */";
const LIMIT_SENTINEL = "/* pui-goal-patch:utf8-completion-limit */";
const COMMAND_SENTINEL = "/* pui-goal-patch:preserve-objective-formatting */";
const FORMAT_COMPLETE_LINE = '  if (goal.status === "complete") return "Goal: complete \\xB7 " + formatDuration(goal.timeUsedSeconds);';
const COMPLETION_CALL = "      runtime.clearCompletedGoal(ctx);\n      runtime.showCompletionStatus(ctx);";
const COMPLETION_GUARD = "This goal_id is only the goal_complete tool stale-turn guard, not part of the objective. If and only if the goal is fully complete, pass this exact goal_id to goal_complete with the completion summary.";
const COMPLETION_RULE = "`- Only call the goal_complete tool after evidence proves every requirement of ${goalLabel} is satisfied and no required work remains. Pass this exact goal_id and never reuse an id from an older, stopped, replaced, or cleared turn.`";
const COMPLETION_TOOL_DESCRIPTION = "Mark an active /goal complete only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and every requirement is verified. Tool visibility alone does not activate Goal mode. Never call for ordinary work, partial progress, blockers, failures, or unverified work.";
const COMPLETION_DESCRIPTION = "State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.";
const SUMMARY_LENGTH_CONSTANT = "var MAX_COMPLETION_SUMMARY_LENGTH = 4e3;\n";
const SUMMARY_SCHEMA_MAX_LENGTH = "        maxLength: MAX_COMPLETION_SUMMARY_LENGTH,\n";
const SUMMARY_VALIDATION = '      const rejectionReason = !summary ? "summary is empty" : summary.length > MAX_COMPLETION_SUMMARY_LENGTH ? "summary is too long" : isContradictoryCompletionSummary(summary) ? "summary says the goal is not complete" : void 0;';
const SUMMARY_DETAILS = "    summary: summary.slice(0, MAX_COMPLETION_SUMMARY_LENGTH)";
const TURN_END_BLOCK = [
  '  pi.on("turn_end", (event, ctx) => {',
  "    runtime.recordAutomaticTurn(ctx, event.message);",
  '    if (runtime.activeGoal?.status !== "active") {',
  "      runtime.ensureInactiveGoalContextContract(ctx);",
  "    }",
  "  });",
].join("\n");

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

const NEW_COMPLETION_GUARD = COMPLETION_GUARD.replace(
  "pass this exact goal_id to goal_complete with the completion summary.",
  "call goal_complete alone as the final action with this exact goal_id. Its summary is the complete final response that should be shown to the user. Include every user-facing deliverable required by the objective and concise verification evidence where relevant; do not promise to deliver content in a later message.",
);
const NEW_COMPLETION_RULE = "`- Call goal_complete alone as the final action only after evidence proves every requirement of ${goalLabel} is satisfied and no required work remains. Its summary is the complete user-visible result, so include every required deliverable directly and never promise to provide it in a later message. Pass this exact goal_id and never reuse an id from an older, stopped, replaced, or cleared turn.`";
const NEW_COMPLETION_TOOL_DESCRIPTION = `${COMPLETION_TOOL_DESCRIPTION} Call it alone as the final action; its summary is the complete user-visible response.`;
const NEW_COMPLETION_DESCRIPTION = "Provide the complete final response that should be shown to the user when the Goal finishes. Include every user-facing deliverable required by the objective and concise verification evidence where relevant. Do not report partial work, remaining work, or promise to deliver content in a later message.";
const BYTE_LIMIT_COMPLETION_DESCRIPTION = `${NEW_COMPLETION_DESCRIPTION} The UTF-8 encoded response must not exceed 50 KB.`;
const NEW_SUMMARY_VALIDATION = [
  '      const summaryBytes = Buffer.byteLength(summary, "utf8");',
  '      const rejectionReason = !summary ? "summary is empty" : summaryBytes > DEFAULT_MAX_BYTES ? "summary exceeds the 50 KB UTF-8 limit" : isContradictoryCompletionSummary(summary) ? "summary says the goal is not complete" : void 0;',
].join("\n");
const NEW_TURN_END_BLOCK = [
  DISPLAY_SENTINEL,
  '  pi.on("turn_end", (event, ctx) => {',
  "    runtime.recordAutomaticTurn(ctx, event.message);",
  "    const completedResult = event.toolResults.find((result) => {",
  "      if (result.toolName === GOAL_COMPLETE_TOOL && !result.isError) {",
  '        const summary = typeof result.details?.summary === "string" ? result.details.summary.trim() : "";',
  '        const text = result.content.find((block) => block.type === "text")?.text;',
  "        return summary !== \"\" && text === `Goal complete: ${summary}`;",
  "      }",
  "      return false;",
  "    });",
  '    const completionSummary = typeof completedResult?.details?.summary === "string" ? completedResult.details.summary.trim() : "";',
  '    if (runtime.activeGoal?.status !== "active") {',
  "      runtime.ensureInactiveGoalContextContract(ctx);",
  "    }",
  "    if (completionSummary) {",
  "      pi.sendMessage({",
  '        customType: "Goal complete",',
  "        content: completionSummary,",
  "        display: true",
  "      }, { triggerTurn: false });",
  "    }",
  "  });",
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

function patchCommandParser(text) {
  if (text.includes(COMMAND_SENTINEL)) return { patched: false, reason: "already-patched", text };
  const parseStart = "function parseCommand(args) {";
  const parseEnd = "\nfunction isRemovedQueueCommand";
  const startIdx = text.indexOf(parseStart);
  const endIdx = text.indexOf(parseEnd, startIdx + parseStart.length);
  if (startIdx === -1 || endIdx === -1) return { patched: false, reason: "anchor-missing", text };

  let parser = text.slice(startIdx, endIdx);
  const inputAnchor = "  const tokens = tokenize(args.trim());";
  const startAnchor = '  return parseObjective("start", tokens);';
  if (!parser.includes(inputAnchor) || !parser.includes(startAnchor)) return { patched: false, reason: "anchor-missing", text };
  parser = parser
    .replace(inputAnchor, "  const input = args.trim();\n  const tokens = tokenize(input);")
    .replace(startAnchor, '  return parseObjective("start", tokens, input);');

  const objectiveAnchor = '  return { kind, objective: objectiveTokens.join(" "), tokenBudget };';
  const tokenizeAnchor = "\nfunction tokenize(input) {";
  if (!text.includes(objectiveAnchor) || !text.includes(tokenizeAnchor)) return { patched: false, reason: "anchor-missing", text };
  const objectiveReplacement = [
    "  const objective = source === void 0",
    '    ? objectiveTokens.join(" ")',
    "    : puiGoalFormattedObjective(source, tokenBudget === void 0 ? 0 : 2);",
    "  return { kind, objective, tokenBudget };",
  ].join("\n");
  const helper = [
    COMMAND_SENTINEL,
    "function puiGoalFormattedObjective(input, skippedTokens) {",
    "  let index = 0;",
    "  let completedTokens = 0;",
    "  let inToken = false;",
    "  let quote;",
    "  for (; index < input.length && completedTokens < skippedTokens; index += 1) {",
    "    const char = input[index];",
    "    if (quote) {",
    "      inToken = true;",
    "      if (char === quote) quote = void 0;",
    "      continue;",
    "    }",
    "    if (char === '\"' || char === \"'\") {",
    "      quote = char;",
    "      inToken = true;",
    "      continue;",
    "    }",
    "    if (/\\s/.test(char)) {",
    "      if (inToken) { completedTokens += 1; inToken = false; }",
    "      continue;",
    "    }",
    "    inToken = true;",
    "  }",
    "  let source = input.slice(index).trim();",
    '  let output = "";',
    "  quote = void 0;",
    "  for (const char of source) {",
    "    if (quote) {",
    "      if (char === quote) quote = void 0;",
    "      else output += char;",
    "      continue;",
    "    }",
    "    if (char === '\"' || char === \"'\") { quote = char; continue; }",
    "    output += char;",
    "  }",
    "  return output.trim();",
    "}",
  ].join("\n");

  const withParser = text.slice(0, startIdx) + parser + text.slice(endIdx);
  return {
    patched: true,
    text: withParser
      .replace("function parseObjective(kind, tokens) {", "function parseObjective(kind, tokens, source) {")
      .replace(objectiveAnchor, objectiveReplacement)
      .replace(tokenizeAnchor, `\n${helper}\nfunction tokenize(input) {`),
  };
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

function patchCompletionPrompt(text) {
  if (text.includes(PROMPT_SENTINEL)) return { patched: false, reason: "already-patched", text };
  if (!text.includes(COMPLETION_GUARD)) return { patched: false, reason: "guard-anchor-missing", text };
  if (!text.includes(COMPLETION_RULE)) return { patched: false, reason: "rule-anchor-missing", text };
  const replaced = text.replace(COMPLETION_GUARD, NEW_COMPLETION_GUARD).replace(COMPLETION_RULE, NEW_COMPLETION_RULE);
  return {
    patched: true,
    text: replaced.replace("function goalCompletionGuardBlock", `${PROMPT_SENTINEL}\nfunction goalCompletionGuardBlock`),
  };
}

function patchCompletionLimit(text) {
  if (text.includes(LIMIT_SENTINEL)) return { patched: false, reason: "already-patched", text };
  if (!text.includes(SUMMARY_LENGTH_CONSTANT)) return { patched: false, reason: "constant-anchor-missing", text };
  if (!text.includes(SUMMARY_SCHEMA_MAX_LENGTH)) return { patched: false, reason: "schema-anchor-missing", text };
  if (!text.includes(SUMMARY_VALIDATION)) return { patched: false, reason: "validation-anchor-missing", text };
  if (!text.includes(SUMMARY_DETAILS)) return { patched: false, reason: "details-anchor-missing", text };
  if (!text.includes(NEW_COMPLETION_DESCRIPTION)) return { patched: false, reason: "description-anchor-missing", text };
  return {
    patched: true,
    text: text
      .replace(SUMMARY_LENGTH_CONSTANT, `${LIMIT_SENTINEL}\n`)
      .replace(SUMMARY_SCHEMA_MAX_LENGTH, "")
      .replace(SUMMARY_VALIDATION, NEW_SUMMARY_VALIDATION)
      .replace(SUMMARY_DETAILS, "    summary")
      .replace(NEW_COMPLETION_DESCRIPTION, BYTE_LIMIT_COMPLETION_DESCRIPTION),
  };
}

function patchCompletionDisplay(text) {
  if (text.includes(DISPLAY_SENTINEL)) return { patched: false, reason: "already-patched", text };
  if (!text.includes(TURN_END_BLOCK)) return { patched: false, reason: "turn-end-anchor-missing", text };
  if (!text.includes(COMPLETION_TOOL_DESCRIPTION)) return { patched: false, reason: "tool-description-anchor-missing", text };
  if (!text.includes(COMPLETION_DESCRIPTION)) return { patched: false, reason: "description-anchor-missing", text };
  return {
    patched: true,
    text: text
      .replace(TURN_END_BLOCK, NEW_TURN_END_BLOCK)
      .replace(COMPLETION_TOOL_DESCRIPTION, NEW_COMPLETION_TOOL_DESCRIPTION)
      .replace(COMPLETION_DESCRIPTION, NEW_COMPLETION_DESCRIPTION),
  };
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
  const promptResult = patchCompletionPrompt(completionResult.text);
  if (!promptResult.patched && promptResult.reason !== "already-patched") {
    return { ok: false, reason: `completion-prompt-${promptResult.reason}`, file: found.file };
  }
  const commandResult = patchCommandParser(promptResult.text);
  if (!commandResult.patched && commandResult.reason !== "already-patched") {
    return { ok: false, reason: `command-${commandResult.reason}`, file: found.file };
  }
  const callResult = patchCompletionCall(entry.text);
  if (!callResult.patched && callResult.reason !== "already-patched") {
    return { ok: false, reason: `completion-call-${callResult.reason}`, file: entry.file };
  }
  const displayResult = patchCompletionDisplay(callResult.text);
  if (!displayResult.patched && displayResult.reason !== "already-patched") {
    return { ok: false, reason: `completion-display-${displayResult.reason}`, file: entry.file };
  }
  const limitResult = patchCompletionLimit(displayResult.text);
  if (!limitResult.patched && limitResult.reason !== "already-patched") {
    return { ok: false, reason: `completion-limit-${limitResult.reason}`, file: entry.file };
  }

  if (formatResult.patched || completionResult.patched || promptResult.patched || commandResult.patched) fs.writeFileSync(found.file, commandResult.text, "utf8");
  if (callResult.patched || displayResult.patched || limitResult.patched) fs.writeFileSync(entry.file, limitResult.text, "utf8");
  return {
    ok: true,
    action: formatResult.patched || completionResult.patched || promptResult.patched || commandResult.patched || callResult.patched || displayResult.patched || limitResult.patched ? "patched" : "already-patched",
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
  if (!found.text.includes(PROMPT_SENTINEL)) return { ok: false, reason: "completion-prompt-missing", file: found.file, entry: entry.file };
  if (!found.text.includes(COMMAND_SENTINEL) || !found.text.includes("puiGoalFormattedObjective")) return { ok: false, reason: "command-formatting-missing", file: found.file, entry: entry.file };
  if (!entry.text.includes(ENTRY_SENTINEL)) return { ok: false, reason: "completion-call-missing", file: found.file, entry: entry.file };
  if (!entry.text.includes(DISPLAY_SENTINEL)) return { ok: false, reason: "completion-display-missing", file: found.file, entry: entry.file };
  if (!entry.text.includes(LIMIT_SENTINEL) || !entry.text.includes('Buffer.byteLength(summary, "utf8")') || entry.text.includes("MAX_COMPLETION_SUMMARY_LENGTH")) {
    return { ok: false, reason: "completion-limit-missing", file: found.file, entry: entry.file };
  }
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
  patchCompletionDisplay,
  patchCompletionLimit,
  patchCompletionPrompt,
  patchCommandParser,
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
  COMMAND_SENTINEL,
  SENTINEL,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));