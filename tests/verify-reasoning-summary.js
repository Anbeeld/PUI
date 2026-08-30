#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { applyBranding } = require("../lib/pui-branding.js");
const { applyIntegration, finalizeIntegration, removeIntegration } = require("../lib/pui-web-integration.js");
const patch = require("../lib/pui-reasoning-summary-patch.js");

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

function runNpm(args, options = {}) {
  const [command, ...commandArgs] = npmCommand(args);
  const result = spawnSync(command, commandArgs, { cwd: repoRoot, encoding: "utf8", stdio: "inherit", ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(`npm ${args.join(" ")} exited ${result.status}`);
}

function globalRoot(prefix) {
  const [command, ...args] = npmCommand(["root", "-g", "--prefix", prefix]);
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || "npm root failed");
  return result.stdout.trim();
}

function helperPrelude(source, lastFunction) {
  const start = source.indexOf("function pui");
  const functionStart = source.indexOf(`function ${lastFunction}`);
  const open = source.indexOf("{", functionStart);
  assert.ok(start >= 0 && functionStart >= 0 && open >= 0, `${lastFunction} helper missing`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${lastFunction} helper is unterminated`);
}

function manifestTarget(root, manifest, key) {
  const entry = Object.entries(manifest.files).find(([, record]) => record.key === key);
  assert.ok(entry, `${key} ownership record missing`);
  return path.join(root, ...entry[0].split("/"));
}

async function verifyBehavior(piWebRoot, piAgentRoot, webManifest, temp) {
  const aiFile = manifestTarget(piWebRoot, webManifest, "web-ai-source");
  const aiSource = fs.readFileSync(aiFile, "utf8");
  const aiContext = { globalThis: {} };
  vm.runInNewContext(`${helperPrelude(aiSource, "puiSafeReasoningPartial")}\nglobalThis.safe = puiSafeReasoningPartial;`, aiContext);
  const output = { role: "assistant", api: "openai-responses", provider: "arbitrary-provider", model: "future-reasoning-model", content: [{ type: "thinking", thinking: "raw chain of thought", thinkingSignature: "encrypted", puiReasoningSummaryText: "Safe summary" }] };
  const safe = aiContext.globalThis.safe(output, { id: "future-reasoning-model", api: "openai-responses" });
  assert.equal(safe.content[0].type, "text");
  assert.equal(safe.content[0].text, "Safe summary");
  assert.doesNotMatch(JSON.stringify(safe), /raw chain of thought|encrypted|thinkingSignature/);
  assert.equal(output.content[0].thinking, "raw chain of thought", "provider output was mutated");
  assert.equal(aiContext.globalThis.safe(output, { id: "any-model", api: "openai-completions" }), output, "non-Responses behavior changed");
  assert.equal(aiContext.globalThis.safe(output, { id: "another-model", api: "anthropic-messages" }), output, "unsupported API behavior changed");

  const aiModule = await import(`${pathToFileURL(aiFile).href}?pui-verify=${Date.now()}`);
  const parserOutput = {
    role: "assistant", api: "openai-responses", provider: "arbitrary-provider", model: "future-reasoning-model", content: [], stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const reasoningItem = { id: "reasoning-1", type: "reasoning", summary: [{ type: "summary_text", text: "Safe summary" }], encrypted_content: "encrypted" };
  const parserEvents = [
    { type: "response.output_item.added", output_index: 0, item: reasoningItem },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Safe summary" },
    { type: "response.reasoning_text.delta", output_index: 0, delta: "raw chain of thought" },
    { type: "response.output_item.done", output_index: 0, item: reasoningItem },
    { type: "response.completed", response: { id: "response-1", status: "completed", output: [reasoningItem] } },
  ];
  const parserPushed = [];
  await aiModule.processResponsesStream({ async *[Symbol.asyncIterator]() { yield* parserEvents; } }, parserOutput, { push: (event) => parserPushed.push(event) }, {
    id: "future-reasoning-model", api: "openai-responses", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(parserOutput.content[0].thinking, "Safe summary", "persisted provider output changed");
  assert.match(parserOutput.content[0].thinkingSignature, /encrypted_content/, "encrypted replay signature was not preserved");
  for (const event of parserPushed) assert.doesNotMatch(JSON.stringify(event), /raw chain of thought|encrypted_content|thinkingSignature/, `unsafe provider event: ${event.type}`);
  const thinkingEnd = parserPushed.find((event) => event.type === "thinking_end");
  assert.equal(thinkingEnd.content, "Safe summary");
  assert.equal(thinkingEnd.partial.content[0].text, "Safe summary");
  assert.equal(parserPushed.find((event) => event.type === "thinking_delta" && event.delta === "").delta, "");

  const eventsSource = fs.readFileSync(manifestTarget(piWebRoot, webManifest, "web-events-route"), "utf8");
  const eventContext = { globalThis: {} };
  vm.runInNewContext(`${helperPrelude(eventsSource, "puiProjectAgentEvent")}\nglobalThis.project = puiProjectAgentEvent;`, eventContext);
  const message = { role: "assistant", api: "openai-responses", provider: "arbitrary-provider", model: "future-reasoning-model", content: [{ type: "thinking", thinking: "raw chain of thought", thinkingSignature: JSON.stringify({ type: "reasoning", summary: [{ type: "summary_text", text: "Safe summary" }], encrypted_content: "encrypted" }) }] };
  const event = eventContext.globalThis.project({ type: "message_start", message });
  assert.equal(event.message.content[0].text, "Safe summary");
  assert.doesNotMatch(JSON.stringify(event), /raw chain of thought|encrypted_content|thinkingSignature/);

  const exportFile = manifestTarget(piWebRoot, webManifest, "web-export-module");
  const exportSource = fs.readFileSync(exportFile, "utf8");
  assert.equal((exportSource.match(/puiProjectSessionEntries\(sm\.getEntries\(\)\)/g) || []).length, 2, "Pi Web HTML export boundaries are not both projected");
  const exportModule = await import(`${pathToFileURL(exportFile).href}?pui-verify=${Date.now()}`);
  const sessionFile = path.join(temp, "session.jsonl");
  const outputFile = path.join(temp, "session.html");
  fs.writeFileSync(sessionFile, "fixture\n");
  await exportModule.exportSessionToHtml({
    getSessionFile: () => sessionFile,
    getEntries: () => [{ type: "message", id: "entry-1", parentId: null, timestamp: new Date().toISOString(), message }],
    getHeader: () => ({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: temp }),
    getLeafId: () => "entry-1",
  }, {}, { outputPath: outputFile });
  const html = fs.readFileSync(outputFile, "utf8");
  const encodedSession = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1];
  assert.ok(encodedSession, "exported session payload missing");
  const exportedSession = Buffer.from(encodedSession, "base64").toString("utf8");
  assert.match(exportedSession, /Safe summary/);
  assert.doesNotMatch(exportedSession, /raw chain of thought|encrypted_content|thinkingSignature/);

  const standaloneSessionFile = path.join(temp, "standalone-session.jsonl");
  const standaloneOutputFile = path.join(temp, "standalone-session.html");
  fs.writeFileSync(standaloneSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: temp })}\n${JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp: new Date().toISOString(), message })}\n`);
  const standaloneExport = spawnSync(process.execPath, [path.join(piAgentRoot, "dist", "bundle", "cli.js"), "--export", standaloneSessionFile, standaloneOutputFile], { cwd: temp, encoding: "utf8" });
  assert.equal(standaloneExport.status, 0, standaloneExport.stderr || standaloneExport.stdout);
  const standaloneHtml = fs.readFileSync(standaloneOutputFile, "utf8");
  const standaloneEncoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(standaloneHtml)?.[1];
  assert.ok(standaloneEncoded, "standalone exported session payload missing");
  const standaloneSession = Buffer.from(standaloneEncoded, "base64").toString("utf8");
  assert.match(standaloneSession, /Safe summary/);
  assert.doesNotMatch(standaloneSession, /raw chain of thought|encrypted_content|thinkingSignature/);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-reasoning-release-"));
  const webPrefix = path.join(temp, "web");
  const standalonePrefix = path.join(temp, "standalone");
  try {
    runNpm(["install", "-g", "--prefix", webPrefix, "--ignore-scripts", `${stack.upstream.gui.npm}@${stack.upstream.gui.version}`]);
    runNpm(["install", "-g", "--prefix", standalonePrefix, "--ignore-scripts", `${stack.upstream.agentRuntime.npm}@${stack.upstream.agentRuntime.version}`]);

    const piWebRoot = path.join(globalRoot(webPrefix), "@agegr", "pi-web");
    const piAgentRoot = path.join(globalRoot(standalonePrefix), "@earendil-works", "pi-coding-agent");
    assert.ok(applyBranding(piWebRoot) > 0, "published Pi Web branding transform made no change");
    applyIntegration({ repoRoot, piWebRoot });

    const applied = patch.apply({ repoRoot, piWebRoot, piAgentRoot });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(patch.verify({ repoRoot, piWebRoot, piAgentRoot }).ok, true);
    assert.equal(finalizeIntegration({ repoRoot, piWebRoot }).ok, true);

    const webManifest = JSON.parse(fs.readFileSync(path.join(piWebRoot, patch.MANIFEST), "utf8"));
    const standaloneManifest = JSON.parse(fs.readFileSync(path.join(piAgentRoot, patch.MANIFEST), "utf8"));
    assert.equal(Object.keys(webManifest.files).length, 13);
    assert.equal(Object.keys(standaloneManifest.files).length, 2);
    const clientBundle = manifestTarget(piWebRoot, webManifest, "web-client-page");
    const clientText = fs.readFileSync(clientBundle, "utf8");
    assert.match(clientText, /"subagent-notification"!==[A-Za-z_$][\w$]*\.customType/, "subagent notifications are not collapsed by default");
    assert.match(clientText, /onClick:"subagent-notification"===[A-Za-z_$][\w$]*\.customType\?\(\)=>[A-Za-z_$][\w$]*\(/, "subagent notification header row is not clickable");
    assert.match(clientText, /role:"subagent-notification"===[A-Za-z_$][\w$]*\.customType\?"button":void 0/, "subagent notification header toggle is not accessible");
    assert.match(clientText, /"aria-expanded":"subagent-notification"===[A-Za-z_$][\w$]*\.customType\?[A-Za-z_$][\w$]*:void 0/, "subagent notification expansion state is not exposed");
    assert.match(clientText, /points:"2 3\.5 5 6\.5 8 3\.5"/, "subagent notification header chevron is missing");
    assert.match(clientText, /marginLeft:[A-Za-z_$][\w$]*\?0:"auto"/, "subagent notification timestamp is not grouped with its chevron");
    assert.match(clientText, /borderBottom:"subagent-notification"===[A-Za-z_$][\w$]*\.customType&&!/, "collapsed subagent notification is not a single header row");
    assert.match(clientText, /className:"Goal complete"===[A-Za-z_$][\w$]*\.customType\?"markdown-compaction-message":"markdown-custom-message"/, "Goal completion does not reuse compaction typography");
    assert.match(clientText, /case"connected":[^;]+isStreaming&&\([^;]+\.puiCustomMessageReconcile=!0/, "streaming reconnect does not schedule custom-prompt reconciliation");
    assert.match(clientText, /\.puiCustomMessageReconcile&&\([^;]+\.puiCustomMessageReconcile=!1,[A-Za-z_$][\w$]*\.current&&void [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.current\)/, "first assistant snapshot does not recover persisted custom prompts");
    const clientVersion = crypto.createHash("sha256").update(clientText).digest("hex").slice(0, 12);
    const clientHtml = fs.readFileSync(path.join(piWebRoot, ".next", "server", "app", "index.html"), "utf8");
    assert.ok(clientHtml.includes(`${path.basename(clientBundle)}?pui=${clientVersion}`), "client reference was not versioned from the final reasoning-patched bundle");
    await verifyBehavior(piWebRoot, piAgentRoot, webManifest, temp);

    const removed = patch.remove(piWebRoot, piAgentRoot, repoRoot);
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(removeIntegration(piWebRoot).action, "removed");
    console.log(`Published ${stack.upstream.gui.npm}@${stack.upstream.gui.version} and ${stack.upstream.agentRuntime.npm}@${stack.upstream.agentRuntime.version} Responses reasoning-summary artifacts passed`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
