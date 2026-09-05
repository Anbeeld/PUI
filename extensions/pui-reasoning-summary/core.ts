import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ReasoningSummaryMode = "auto" | "concise" | "detailed" | "none";

type ModelIdentity = { api?: string; provider?: string; id?: string };
type ReasoningSummaryConfig = { schemaVersion: 1; modelModes: Record<string, ReasoningSummaryMode> };
type ProviderRequestEvent = { payload: unknown };
type ProviderRequestContext = { model?: ModelIdentity };
type PiLike = {
  on(name: "before_provider_request", handler: (event: ProviderRequestEvent, context: ProviderRequestContext) => unknown): void;
};

const SUPPORTED_APIS = new Set([
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);
const MODES = new Set<ReasoningSummaryMode>(["auto", "concise", "detailed", "none"]);

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "pui", "reasoning-summaries.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseConfig(value: unknown): ReasoningSummaryConfig | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.modelModes)) return undefined;
  const modelModes: Record<string, ReasoningSummaryMode> = {};
  for (const [model, mode] of Object.entries(value.modelModes)) {
    if (model === "" || model !== model.trim() || typeof mode !== "string" || !MODES.has(mode as ReasoningSummaryMode)) return undefined;
    modelModes[model] = mode as ReasoningSummaryMode;
  }
  return { schemaVersion: 1, modelModes };
}

export function loadConfig(configPath: string): ReasoningSummaryConfig | undefined {
  try {
    if (!fs.existsSync(configPath)) return undefined;
    return parseConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
  } catch {
    return undefined;
  }
}

export function resolveMode(config: ReasoningSummaryConfig, model: ModelIdentity): ReasoningSummaryMode | undefined {
  if (typeof model.id !== "string") return undefined;
  if (typeof model.provider === "string") {
    const qualified = config.modelModes[`${model.provider}/${model.id}`];
    if (qualified !== undefined) return qualified;
  }
  return config.modelModes[model.id];
}

export function transformPayload(payload: unknown, model: ModelIdentity, mode: ReasoningSummaryMode): unknown | undefined {
  if (!SUPPORTED_APIS.has(model.api || "") || !isRecord(payload) || !isRecord(payload.reasoning)) return undefined;
  if (typeof payload.reasoning.effort !== "string" || payload.reasoning.effort === "none") return undefined;
  if (mode === "none" && payload.reasoning.summary === undefined) return undefined;
  if (mode !== "none" && payload.reasoning.summary === mode) return undefined;

  const reasoning = { ...payload.reasoning };
  if (mode === "none") delete reasoning.summary;
  else reasoning.summary = mode;
  return { ...payload, reasoning };
}

export function registerPuiReasoningSummary(pi: PiLike, options: { configPath?: string } = {}): void {
  const configPath = options.configPath || defaultConfigPath();
  pi.on("before_provider_request", (event, context) => {
    const config = loadConfig(configPath);
    if (!config || !context.model || !SUPPORTED_APIS.has(context.model.api || "")) return undefined;
    const mode = resolveMode(config, context.model);
    if (mode === undefined) return undefined;
    const payload = transformPayload(event.payload, context.model, mode);
    return payload;
  });
}
