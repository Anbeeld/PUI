import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ToolCapabilityPolicy {
  allow?: string[];
  deny?: string[];
}

export interface ModelCapabilityPolicy {
  id: string;
  tools: ToolCapabilityPolicy;
}

export interface ModelPolicyConfig {
  schemaVersion: 1;
  providers: Record<string, { models: ModelCapabilityPolicy[] }>;
}

type ModelIdentity = { provider: string; id: string };
type ModelPolicyPi = Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "on" | "setActiveTools">;
type LoadResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; config: ModelPolicyConfig };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim();
}

function parseToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of value) {
    if (!validName(name) || seen.has(name)) return undefined;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function parseConfig(value: unknown): ModelPolicyConfig | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.providers) ||
      !hasOnlyKeys(value, ["schemaVersion", "providers"])) return undefined;
  const providers: ModelPolicyConfig["providers"] = {};
  for (const [provider, providerValue] of Object.entries(value.providers)) {
    if (!validName(provider) || !isRecord(providerValue) || !Array.isArray(providerValue.models) ||
        !hasOnlyKeys(providerValue, ["models"])) return undefined;
    const models: ModelCapabilityPolicy[] = [];
    const modelIds = new Set<string>();
    for (const modelValue of providerValue.models) {
      if (!isRecord(modelValue) || !validName(modelValue.id) || modelIds.has(modelValue.id) ||
          !isRecord(modelValue.tools) || !hasOnlyKeys(modelValue, ["id", "tools"]) ||
          !hasOnlyKeys(modelValue.tools, ["allow", "deny"])) return undefined;
      const hasAllow = Object.hasOwn(modelValue.tools, "allow");
      const hasDeny = Object.hasOwn(modelValue.tools, "deny");
      if (hasAllow === hasDeny) return undefined;
      const names = parseToolNames(hasAllow ? modelValue.tools.allow : modelValue.tools.deny);
      if (!names) return undefined;
      modelIds.add(modelValue.id);
      models.push({ id: modelValue.id, tools: hasAllow ? { allow: names } : { deny: names } });
    }
    providers[provider] = { models };
  }
  return { schemaVersion: 1, providers };
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "pui", "model-policy.json");
}

function loadConfig(configPath: string): LoadResult {
  try {
    if (!fs.existsSync(configPath)) return { status: "missing" };
    const config = parseConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
    return config ? { status: "valid", config } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

export function policyForModel(config: ModelPolicyConfig, model: ModelIdentity): ModelCapabilityPolicy | undefined {
  return config.providers[model.provider]?.models.find((candidate) => candidate.id === model.id);
}

function toolProhibited(policy: ModelCapabilityPolicy | undefined, toolName: string): boolean {
  if (!policy) return false;
  if (policy.tools.allow) return !policy.tools.allow.includes(toolName);
  return policy.tools.deny?.includes(toolName) === true;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function registerPuiModelPolicy(
  pi: ModelPolicyPi,
  options: { configPath?: string } = {},
): void {
  const configPath = options.configPath || defaultConfigPath();
  const removedByPolicy = new Set<string>();
  let invalidNotified = false;

  const apply = (model: ModelIdentity | undefined, context?: ExtensionContext): void => {
    const loaded = loadConfig(configPath);
    const current = pi.getActiveTools();
    const configuredNames = pi.getAllTools().map((tool) => tool.name);
    const restorable = new Set([...current, ...removedByPolicy].filter((name) => configuredNames.includes(name)));
    const baseline = configuredNames.filter((name) => restorable.has(name));
    removedByPolicy.clear();

    let next = baseline;
    if (loaded.status === "invalid") {
      next = [];
      for (const name of baseline) removedByPolicy.add(name);
      if (!invalidNotified) {
        context?.ui.notify(`Invalid PUI model policy; tools are disabled until ${configPath} is fixed`, "error");
        invalidNotified = true;
      }
    } else {
      invalidNotified = false;
      const policy = loaded.status === "valid" && model ? policyForModel(loaded.config, model) : undefined;
      next = baseline.filter((name) => {
        const prohibited = toolProhibited(policy, name);
        if (prohibited) removedByPolicy.add(name);
        return !prohibited;
      });
    }
    if (!sameNames(current, next)) pi.setActiveTools(next);
  };

  pi.on("session_start", (_event, context) => apply(context.model, context));
  pi.on("model_select", (event, context) => apply(event.model, context));
  pi.on("before_agent_start", (_event, context) => apply(context.model, context));
  pi.on("tool_result", (_event, context) => apply(context.model, context));
  pi.on("tool_call", (event, context) => {
    const loaded = loadConfig(configPath);
    if (loaded.status === "invalid") {
      return { block: true, reason: "PUI model policy is invalid; tool execution is disabled" };
    }
    const policy = loaded.status === "valid" && context.model
      ? policyForModel(loaded.config, context.model)
      : undefined;
    if (toolProhibited(policy, event.toolName)) {
      return {
        block: true,
        reason: `PUI model policy prohibits ${context.model.provider}/${context.model.id} from using ${event.toolName}`,
      };
    }
  });
}
