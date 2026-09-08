import fs from "node:fs";
import path from "node:path";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2000;

export const PROMPT_GUIDELINES = [
  "At the start of each task and at every material task or phase change, call `load_skill` for every directly matching skill, including each matching part of a mixed task. Skill descriptions are routing metadata for this selection.",
  "If a skill match is unclear, inspect only enough of the work to decide whether to call `load_skill`.",
  "After `load_skill` returns a skill, follow its instructions and load any required references before starting that work.",
  "Do not call `load_skill` for skills merely adjacent to the work or for content already in context.",
  "For skill references, pass `reference` to `load_skill` as one listed filename or a list (`.md` optional). Resolve other relative paths from the returned skill directory.",
];

const CATALOG_HEADING = "Available skills:";

export const TOOL_DESCRIPTION = "Load a directly matching skill or its required Markdown references before starting that work. `name` alone returns SKILL.md, its directory, and reference filenames. `reference` accepts one listed filename or a list (`.md` optional), including the parent skill when absent from active context. Requests already satisfied in active context return an already-loaded notice. Names must be exact; references must be filenames, not paths.";

interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}

interface TypeApi {
  String(options?: Record<string, unknown>): unknown;
  Optional(schema: unknown): unknown;
  Array(schema: unknown, options?: Record<string, unknown>): unknown;
  Union(schemas: unknown[], options?: Record<string, unknown>): unknown;
  Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
}

interface LoaderDetails {
  puiSkillLoader: 1;
  kind: "skill" | "reference";
  skill: string;
  reference?: string;
  references?: string[];
  includesSkill?: boolean;
  baseDir?: string;
  containsContent: boolean;
}

interface ExtensionApi {
  on(name: string, handler: (event: any, context: any) => unknown): void;
  registerTool(tool: any): void;
  getActiveTools(): string[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function visibleSkills(skills: Skill[]): Skill[] {
  return skills.filter((skill) => !skill.disableModelInvocation);
}

export function formatOriginalSkills(skills: Skill[]): string {
  const visible = visibleSkills(skills);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export function formatPuiSkills(skills: Skill[]): string {
  const visible = visibleSkills(skills);
  if (visible.length === 0) return "";
  const lines = [`\n\n${CATALOG_HEADING}`, "", "<available_skills>"];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function replaceSkillPrompt(prompt: string, skills: Skill[]): string {
  const replacement = formatPuiSkills(skills);
  if (!replacement) return prompt;
  const original = formatOriginalSkills(skills);
  if (original && prompt.includes(original)) return prompt.replace(original, replacement);
  const opening = prompt.indexOf("<available_skills>");
  const closing = opening < 0 ? -1 : prompt.indexOf("</available_skills>", opening);
  if (closing >= 0) {
    const heading = prompt.lastIndexOf(`\n\n${CATALOG_HEADING}`, opening);
    const headingEnd = heading < 0 ? -1 : heading + 2 + CATALOG_HEADING.length;
    const guidance = prompt.lastIndexOf("\nUse the read tool to load a skill's file", opening);
    const paragraph = prompt.lastIndexOf("\n\n", guidance >= 0 ? guidance : opening);
    const start = heading >= 0 && prompt.slice(headingEnd, opening).trim().length === 0
      ? heading
      : paragraph >= 0 ? paragraph : opening;
    return `${prompt.slice(0, start).trimEnd()}${replacement}${prompt.slice(closing + "</available_skills>".length)}`;
  }
  const footer = "Current working directory:";
  const index = prompt.lastIndexOf(footer);
  if (index < 0) return `${prompt}${replacement}`;
  return `${prompt.slice(0, index).trimEnd()}${replacement}\n${prompt.slice(index)}`;
}

function safeReferenceName(name: string): string {
  if (!name || /[\\/\0\r\n]/.test(name) || name === "." || name === "..") {
    throw new Error("A reference must be a filename, not a path.");
  }
  return name.endsWith(".md") ? name : `${name}.md`;
}

function referenceNames(skill: Skill): string[] {
  const directory = path.join(skill.baseDir, "references");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !/[\0\r\n]/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function skillOutput(skill: Skill, references: string[]): string {
  const instructions = fs.readFileSync(skill.filePath, "utf8").trimEnd();
  const suffix = references.length > 0 ? `\n\nAvailable references: ${references.join(", ")}` : "";
  return `Loaded skill: ${skill.name}\nSkill directory: ${skill.baseDir}\n\nInstructions:\n${instructions}${suffix}`;
}

function assertOutputFits(content: string, label: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = content.split("\n").length;
  if (bytes > MAX_OUTPUT_BYTES || lines > MAX_OUTPUT_LINES) {
    throw new Error(`${label} exceeds the load_skill output limit (${MAX_OUTPUT_BYTES} bytes or ${MAX_OUTPUT_LINES} lines). No partial content was loaded.`);
  }
}

function isLoaderDetails(value: unknown): value is LoaderDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<LoaderDetails>;
  return details.puiSkillLoader === 1 && details.containsContent === true &&
    (details.kind === "skill" || details.kind === "reference") && typeof details.skill === "string";
}

function contentKeys(details: LoaderDetails): string[] {
  if (details.kind === "skill") return [`skill:${details.skill}`];
  const names = Array.isArray(details.references)
    ? details.references
    : details.reference ? [details.reference] : [];
  const keys = names.map((reference) => `reference:${details.skill}/${reference}`);
  if (details.includesSkill === true) keys.unshift(`skill:${details.skill}`);
  return keys;
}

function textResult(text: string, details: LoaderDetails) {
  return { content: [{ type: "text", text }], details };
}

export function registerPuiSkillLoader(pi: ExtensionApi, Type: TypeApi): void {
  let skills = new Map<string, Skill>();
  let loadedContent = new Set<string>();

  pi.on("before_agent_start", (event: any) => {
    const discovered = Array.isArray(event.systemPromptOptions?.skills)
      ? visibleSkills(event.systemPromptOptions.skills as Skill[])
      : [];
    skills = new Map(discovered.map((skill) => [skill.name, skill]));
    if (!pi.getActiveTools().includes("load_skill") || discovered.length === 0) {
      return { systemPrompt: event.systemPrompt };
    }
    return { systemPrompt: replaceSkillPrompt(event.systemPrompt, discovered) };
  });

  pi.on("context", (event: any) => {
    const current = new Set<string>();
    for (const message of event.messages ?? []) {
      if (message?.role === "toolResult" && message.toolName === "load_skill" && isLoaderDetails(message.details)) {
        for (const key of contentKeys(message.details)) current.add(key);
      }
    }
    loadedContent = current;
  });

  pi.registerTool({
    name: "load_skill",
    label: "Load Skill",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Load matching skills and required references before their work begins",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: Type.Object({
      name: Type.String({ description: "Exact skill name from <available_skills>." }),
      reference: Type.Optional(Type.Union([
        Type.String({ description: "Listed reference filename; the final .md is optional." }),
        Type.Array(Type.String(), { minItems: 1, description: "Listed reference filenames; each final .md is optional." }),
      ], { description: "One or more listed reference filenames for that skill." })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId: string, params: { name: string; reference?: string | string[] }) {
      const skill = skills.get(params.name);
      if (!skill) {
        const available = [...skills.keys()].sort((a, b) => a.localeCompare(b, "en"));
        throw new Error(`Skill "${params.name}" is unavailable. Available skills: ${available.join(", ") || "none"}.`);
      }

      if (params.reference === undefined) {
        const key = `skill:${skill.name}`;
        if (loadedContent.has(key)) {
          return textResult(`Skill "${skill.name}" is already loaded.`, {
            puiSkillLoader: 1, kind: "skill", skill: skill.name, containsContent: false,
          });
        }
        const references = referenceNames(skill);
        const output = skillOutput(skill, references);
        assertOutputFits(output, `Skill "${skill.name}"`);
        loadedContent.add(key);
        return textResult(output, {
          puiSkillLoader: 1, kind: "skill", skill: skill.name, baseDir: skill.baseDir, containsContent: true,
        });
      }

      const requested = Array.isArray(params.reference) ? params.reference : [params.reference];
      if (requested.length === 0) {
        throw new Error("Provide at least one reference filename.");
      }
      const normalized: string[] = [];
      for (const entry of requested) {
        const reference = safeReferenceName(String(entry));
        if (!normalized.includes(reference)) normalized.push(reference);
      }
      const available = referenceNames(skill);
      const unavailable = normalized.filter((reference) => !available.includes(reference));
      if (unavailable.length > 0) {
        const quoted = unavailable.map((reference) => `"${reference}"`).join(", ");
        const list = `Available references: ${available.join(", ") || "none"}.`;
        throw new Error(unavailable.length === 1
          ? `Reference ${quoted} is unavailable for skill "${skill.name}". ${list}`
          : `References ${quoted} are unavailable for skill "${skill.name}". ${list}`);
      }
      const includesSkill = !loadedContent.has(`skill:${skill.name}`);
      const missing = includesSkill
        ? normalized
        : normalized.filter((reference) => !loadedContent.has(`reference:${skill.name}/${reference}`));
      const detailsFields = normalized.length === 1
        ? { reference: normalized[0] }
        : { references: normalized };
      if (missing.length === 0) {
        const names = normalized.map((reference) => `"${skill.name}/${reference}"`);
        return textResult(normalized.length === 1
          ? `Reference ${names[0]} is already loaded.`
          : `References ${names.join(", ")} are already loaded.`, {
          puiSkillLoader: 1, kind: "reference", skill: skill.name, ...detailsFields, containsContent: false,
        });
      }

      const parts: { type: "text"; text: string }[] = [];
      if (includesSkill) parts.push({ type: "text", text: skillOutput(skill, available) });
      if (normalized.length > 1) {
        const summaryLines = [
          `Loaded references from skill "${skill.name}": ${missing.join(", ")}`,
          `Skill directory: ${skill.baseDir}`,
        ];
        const already = normalized.filter((reference) => !missing.includes(reference));
        if (already.length > 0) summaryLines.push(`Already loaded: ${already.join(", ")}`);
        parts.push({ type: "text", text: summaryLines.join("\n") });
      }
      for (const reference of missing) {
        const file = path.join(skill.baseDir, "references", reference);
        const content = fs.readFileSync(file, "utf8").trimEnd();
        const directory = normalized.length === 1 && !includesSkill ? `\nSkill directory: ${skill.baseDir}` : "";
        const section = `Loaded reference: ${skill.name}/${reference}${directory}\n\n${content}`;
        assertOutputFits(section, `Reference "${skill.name}/${reference}"`);
        parts.push({ type: "text", text: section });
      }
      assertOutputFits(parts.map((part) => part.text).join("\n"), `References for skill "${skill.name}"`);
      if (includesSkill) loadedContent.add(`skill:${skill.name}`);
      for (const reference of missing) loadedContent.add(`reference:${skill.name}/${reference}`);
      const contentFields = normalized.length === 1
        ? { reference: missing[0] }
        : { references: missing };
      return {
        content: parts,
        details: {
          puiSkillLoader: 1, kind: "reference", skill: skill.name, ...contentFields,
          includesSkill, baseDir: skill.baseDir, containsContent: true,
        },
      };
    },
  });
}
