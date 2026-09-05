const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..");
const coreUrl = pathToFileURL(path.join(repoRoot, "extensions", "pui-skill-loader", "core.ts")).href;

async function loadCore() {
  return import(`${coreUrl}?test=${Date.now()}-${Math.random()}`);
}

function fakeType() {
  return {
    String(options = {}) { return { type: "string", ...options }; },
    Optional(schema) { return { ...schema, optional: true }; },
    Array(schema, options = {}) { return { type: "array", items: schema, ...options }; },
    Union(schemas, options = {}) { return { anyOf: schemas, ...options }; },
    Object(properties, options = {}) { return { type: "object", properties, ...options }; },
  };
}

function fakePi(activeTools = ["load_skill"]) {
  const handlers = new Map();
  let tool;
  return {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(value) { tool = value; },
    getActiveTools() { return [...activeTools]; },
    handler(name) { return handlers.get(name); },
    get tool() { return tool; },
  };
}

function makeSkill(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-skill-loader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseDir = path.join(root, options.name || "prompting");
  const references = path.join(baseDir, "references");
  fs.mkdirSync(references, { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  fs.writeFileSync(filePath, options.body || "# Prompting\n\nFollow the prompting procedure.\n", "utf8");
  for (const [name, content] of Object.entries(options.references || {
    "revision.md": "# Revision\n\nRevise carefully.\n",
    "evaluation.md": "# Evaluation\n\nEvaluate behavior.\n",
  })) fs.writeFileSync(path.join(references, name), content, "utf8");
  return {
    name: options.name || "prompting",
    description: options.description || "Design AI-facing instructions.",
    filePath,
    baseDir,
    sourceInfo: {},
    disableModelInvocation: options.disableModelInvocation === true,
  };
}

function text(result) {
  return result.content.map((part) => part.type === "text" ? part.text : "").join("");
}

async function configure(pi, skill, prompt) {
  return pi.handler("before_agent_start")({
    prompt: "work",
    systemPrompt: prompt,
    systemPromptOptions: {
      selectedTools: pi.getActiveTools(),
      skills: [skill],
      cwd: skill.baseDir,
    },
  }, {});
}

test("initial load returns SKILL.md and a compact sorted reference list", async (t) => {
  const { registerPuiSkillLoader, formatOriginalSkills } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());

  const original = formatOriginalSkills([skill]);
  const changed = await configure(pi, skill, `${original}\nCurrent working directory: ${skill.baseDir}`);
  assert.match(changed.systemPrompt, /At the start of each task and whenever the task or phase materially changes, use `load_skill`/);
  assert.match(changed.systemPrompt, /Pass `reference` as one listed filename or a list \(`\.md` optional\)/);
  assert.doesNotMatch(changed.systemPrompt, /<location>|Use the read tool/);
  assert.match(changed.systemPrompt, /<name>prompting<\/name>/);

  const result = await pi.tool.execute("call-1", { name: "prompting" });
  assert.match(text(result), /Instructions:\n# Prompting/);
  assert.match(text(result), /Available references: evaluation\.md, revision\.md/);
  assert.equal(result.details.containsContent, true);
  assert.equal(result.details.kind, "skill");
});

test("routing prompt covers mixed tasks, identification, required references, and context reuse", async (t) => {
  const { registerPuiSkillLoader, formatOriginalSkills } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  const footer = `Current working directory: ${skill.baseDir}`;
  const changed = await configure(pi, skill, `Preserve project instructions.${formatOriginalSkills([skill])}\n${footer}`);

  assert.match(changed.systemPrompt, /At the start of each task and whenever the task or phase materially changes, use `load_skill` for skills whose descriptions directly match the work, including matching parts of mixed tasks\./);
  assert.match(changed.systemPrompt, /If needed, inspect only enough to identify the work first\./);
  assert.match(changed.systemPrompt, /Follow the loaded instructions and load references they require for the current work before proceeding\./);
  assert.match(changed.systemPrompt, /Do not load merely adjacent skills or content already in context\./);
  assert.match(changed.systemPrompt, /Resolve other relative paths from the returned skill directory\./);
  assert.ok(changed.systemPrompt.startsWith("Preserve project instructions."));
  assert.ok(changed.systemPrompt.endsWith(footer));
  assert.match(changed.systemPrompt, /<name>prompting<\/name>\n\s*<description>Design AI-facing instructions\.<\/description>/);
  assert.doesNotMatch(changed.systemPrompt, /Use the read tool|Before starting work that matches a description/);
});

test("tool metadata leads with skill selection and documents loading results", async () => {
  const { registerPuiSkillLoader } = await loadCore();
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());

  assert.match(pi.tool.description, /^Load a directly matching skill or its required Markdown references before starting that work\./);
  assert.match(pi.tool.description, /`name` alone returns SKILL\.md, its directory, and reference filenames/);
  assert.match(pi.tool.description, /`reference` accepts one listed filename or a list \(`\.md` optional\), including the parent skill when absent from active context/);
  assert.match(pi.tool.description, /Requests already satisfied in active context return an already-loaded notice\./);
  assert.match(pi.tool.description, /Names must be exact; references must be filenames, not paths\./);
  assert.equal(pi.tool.promptSnippet, "Load matching skills and required references before their work begins");
});

test("reference accepts an optional .md suffix after the skill is loaded", async (t) => {
  const { registerPuiSkillLoader } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  await configure(pi, skill, `Current working directory: ${skill.baseDir}`);
  const loadedSkill = await pi.tool.execute("call-1", { name: "prompting" });

  const shortName = await pi.tool.execute("call-2", { name: "prompting", reference: "evaluation" });
  assert.match(text(shortName), /Loaded reference: prompting\/evaluation\.md/);
  assert.match(text(shortName), /# Evaluation/);
  assert.equal(shortName.details.reference, "evaluation.md");

  await pi.handler("context")({ messages: [
    { role: "toolResult", toolName: "load_skill", details: loadedSkill.details },
    { role: "toolResult", toolName: "load_skill", details: shortName.details },
  ] }, {});
  const duplicate = await pi.tool.execute("call-3", { name: "prompting", reference: "evaluation.md" });
  assert.equal(text(duplicate), 'Reference "prompting/evaluation.md" is already loaded.');
  assert.equal(duplicate.details.containsContent, false);
});

test("reference accepts a list of files in one call", async (t) => {
  const { registerPuiSkillLoader } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  await configure(pi, skill, `Current working directory: ${skill.baseDir}`);
  const loadedSkill = await pi.tool.execute("call-1", { name: "prompting" });

  const result = await pi.tool.execute("call-2", { name: "prompting", reference: ["evaluation", "revision"] });
  assert.match(text(result), /Loaded references from skill "prompting": evaluation\.md, revision\.md/);
  assert.match(text(result), /Loaded reference: prompting\/evaluation\.md/);
  assert.match(text(result), /# Evaluation/);
  assert.match(text(result), /Loaded reference: prompting\/revision\.md/);
  assert.match(text(result), /# Revision/);
  assert.deepEqual(result.details.references, ["evaluation.md", "revision.md"]);
  assert.equal(result.details.kind, "reference");
  assert.equal(result.details.containsContent, true);

  await pi.handler("context")({ messages: [
    { role: "toolResult", toolName: "load_skill", details: loadedSkill.details },
    { role: "toolResult", toolName: "load_skill", details: result.details },
  ] }, {});
  const again = await pi.tool.execute("call-3", { name: "prompting", reference: ["evaluation", "revision"] });
  assert.equal(text(again), 'References "prompting/evaluation.md", "prompting/revision.md" are already loaded.');
  assert.equal(again.details.containsContent, false);
});

test("reference list loads only missing files and notes already loaded ones", async (t) => {
  const { registerPuiSkillLoader } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  await configure(pi, skill, `Current working directory: ${skill.baseDir}`);
  const loadedSkill = await pi.tool.execute("call-1", { name: "prompting" });
  const single = await pi.tool.execute("call-2", { name: "prompting", reference: "evaluation" });
  await pi.handler("context")({ messages: [
    { role: "toolResult", toolName: "load_skill", details: single.details },
    { role: "toolResult", toolName: "load_skill", details: { puiSkillLoader: 1, kind: "skill", skill: "prompting", containsContent: true } },
  ] }, {});

  const result = await pi.tool.execute("call-3", { name: "prompting", reference: ["evaluation", "revision"] });
  assert.match(text(result), /Loaded reference: prompting\/revision\.md/);
  assert.match(text(result), /# Revision/);
  assert.match(text(result), /Already loaded: evaluation\.md/);
  assert.doesNotMatch(text(result), /# Evaluation/);
  assert.deepEqual(result.details.references, ["revision.md"]);

  await pi.handler("context")({ messages: [
    { role: "toolResult", toolName: "load_skill", details: loadedSkill.details },
    { role: "toolResult", toolName: "load_skill", details: result.details },
  ] }, {});
  const reloaded = await pi.tool.execute("call-4", { name: "prompting", reference: "evaluation" });
  assert.match(text(reloaded), /# Evaluation/);
});

test("reference lists are validated together before loading anything", async (t) => {
  const { registerPuiSkillLoader } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  await configure(pi, skill, `Current working directory: ${skill.baseDir}`);
  await pi.tool.execute("call-1", { name: "prompting" });

  await assert.rejects(
    () => pi.tool.execute("call-2", { name: "prompting", reference: ["evaluation", "missing"] }),
    /unavailable for skill "prompting".*Available references: evaluation\.md, revision\.md/s,
  );
  const evaluation = await pi.tool.execute("call-3", { name: "prompting", reference: "evaluation" });
  assert.match(text(evaluation), /# Evaluation/);
  await assert.rejects(
    () => pi.tool.execute("call-4", { name: "prompting", reference: ["../x", "revision"] }),
    /filename, not a path/,
  );
  await assert.rejects(
    () => pi.tool.execute("call-5", { name: "prompting", reference: [] }),
    /at least one reference/,
  );
});

test("duplicate references in one call are collapsed", async (t) => {
  const { registerPuiSkillLoader } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  await configure(pi, skill, `Current working directory: ${skill.baseDir}`);
  await pi.tool.execute("call-1", { name: "prompting" });

  const result = await pi.tool.execute("call-2", { name: "prompting", reference: ["revision", "revision.md"] });
  assert.match(text(result), /Loaded reference: prompting\/revision\.md/);
  assert.equal(result.details.reference, "revision.md");
});

test("reference requests include an unloaded parent skill", async (t) => {
  const { registerPuiSkillLoader } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  await configure(pi, skill, `Current working directory: ${skill.baseDir}`);

  const result = await pi.tool.execute("call-1", { name: "prompting", reference: ["evaluation", "revision"] });
  assert.match(text(result), /Loaded skill: prompting/);
  assert.match(text(result), /Instructions:\n# Prompting/);
  assert.match(text(result), /Loaded reference: prompting\/evaluation\.md/);
  assert.match(text(result), /Loaded reference: prompting\/revision\.md/);
  assert.equal(result.details.includesSkill, true);
  assert.deepEqual(result.details.references, ["evaluation.md", "revision.md"]);

  await pi.handler("context")({ messages: [{ role: "toolResult", toolName: "load_skill", details: result.details }] }, {});
  assert.equal(text(await pi.tool.execute("call-2", { name: "prompting" })), 'Skill "prompting" is already loaded.');
  assert.equal(
    text(await pi.tool.execute("call-3", { name: "prompting", reference: ["evaluation", "revision"] })),
    'References "prompting/evaluation.md", "prompting/revision.md" are already loaded.',
  );
});

test("reference loading rejects paths and unavailable files before loading the parent", async (t) => {
  const { registerPuiSkillLoader } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  await configure(pi, skill, `Current working directory: ${skill.baseDir}`);

  await assert.rejects(() => pi.tool.execute("call-1", { name: "prompting", reference: "../evaluation" }), /filename, not a path/);
  await assert.rejects(() => pi.tool.execute("call-2", { name: "prompting", reference: "missing" }), /Available references: evaluation\.md, revision\.md/);
  assert.match(text(await pi.tool.execute("call-3", { name: "prompting" })), /Instructions:\n# Prompting/);
});

test("context reconstruction reloads content removed by compaction or tree navigation", async (t) => {
  const { registerPuiSkillLoader } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  await configure(pi, skill, `Current working directory: ${skill.baseDir}`);

  const loaded = await pi.tool.execute("call-1", { name: "prompting" });
  await pi.handler("context")({ messages: [{ role: "toolResult", toolName: "load_skill", details: loaded.details }] }, {});
  assert.equal(text(await pi.tool.execute("call-2", { name: "prompting" })), 'Skill "prompting" is already loaded.');

  await pi.handler("context")({ messages: [] }, {});
  assert.match(text(await pi.tool.execute("call-3", { name: "prompting" })), /Instructions:\n# Prompting/);
});

test("reference reload includes its parent after the skill leaves context", async (t) => {
  const { registerPuiSkillLoader } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  await configure(pi, skill, `Current working directory: ${skill.baseDir}`);
  await pi.tool.execute("call-1", { name: "prompting" });
  const reference = await pi.tool.execute("call-2", { name: "prompting", reference: "evaluation" });

  await pi.handler("context")({ messages: [{ role: "toolResult", toolName: "load_skill", details: reference.details }] }, {});
  const reloaded = await pi.tool.execute("call-3", { name: "prompting", reference: "evaluation" });
  assert.match(text(reloaded), /Loaded skill: prompting/);
  assert.match(text(reloaded), /Loaded reference: prompting\/evaluation\.md/);
  assert.equal(reloaded.details.includesSkill, true);
});

test("prompt rewrite replaces a noncanonical skill block instead of retaining read guidance", async (t) => {
  const { registerPuiSkillLoader, formatOriginalSkills } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  const modified = formatOriginalSkills([skill]).replace(
    "The following skills provide specialized instructions for specific tasks.",
    "Available specialist instructions:",
  );
  const changed = await configure(pi, skill, `${modified}\nCurrent working directory: ${skill.baseDir}`);
  assert.match(changed.systemPrompt, /use `load_skill`/);
  assert.doesNotMatch(changed.systemPrompt, /Use the read tool|<location>/);
  assert.equal((changed.systemPrompt.match(/<available_skills>/g) || []).length, 1);
});

test("prompt rewrite is idempotent over an already rewritten block", async (t) => {
  const { registerPuiSkillLoader } = await loadCore();
  const skill = makeSkill(t);
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  const first = await configure(pi, skill, `Current working directory: ${skill.baseDir}`);
  const second = await configure(pi, skill, `First section.\n\n${first.systemPrompt}`);
  assert.equal(second.systemPrompt.split("routing metadata").length - 1, 1);
});

test("prompt rewrite is gated by active loader and model-invocable skills", async (t) => {
  const { registerPuiSkillLoader, formatOriginalSkills } = await loadCore();
  const skill = makeSkill(t);
  const original = `${formatOriginalSkills([skill])}\nCurrent working directory: ${skill.baseDir}`;

  const inactive = fakePi([]);
  registerPuiSkillLoader(inactive, fakeType());
  assert.equal((await configure(inactive, skill, original)).systemPrompt, original);

  const disabled = fakePi();
  registerPuiSkillLoader(disabled, fakeType());
  const disabledSkill = { ...skill, disableModelInvocation: true };
  assert.equal((await configure(disabled, disabledSkill, "custom prompt")).systemPrompt, "custom prompt");
});

test("oversized skill and reference content fails without partial output", async (t) => {
  const { registerPuiSkillLoader, MAX_OUTPUT_BYTES } = await loadCore();
  const skill = makeSkill(t, { body: "x".repeat(MAX_OUTPUT_BYTES + 1) });
  const pi = fakePi();
  registerPuiSkillLoader(pi, fakeType());
  await configure(pi, skill, `Current working directory: ${skill.baseDir}`);
  await assert.rejects(() => pi.tool.execute("call-1", { name: "prompting" }), /exceeds the load_skill output limit.*No partial content was loaded/s);
});
