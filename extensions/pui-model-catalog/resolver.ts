import type { Model } from "@earendil-works/pi-ai";

export const PUI_MODEL_RESOLVER_SYMBOL = Symbol.for("pui.model-resolver.v1");
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type AvailableModel = Model<any>;
export interface RankedModel {
  model: AvailableModel;
  providerModelId: string;
  score: number;
  match: "exact-provider-id" | "exact-id" | "id" | "name" | "tokens";
}
export type ModelResolution =
  | { status: "resolved"; model: AvailableModel; matches: RankedModel[] }
  | { status: "ambiguous" | "not-found" | "invalid"; matches: RankedModel[] };
export interface PuiModelResolver {
  version: 1;
  rank(query: string, models: readonly AvailableModel[]): RankedModel[];
  resolve(query: string, models: readonly AvailableModel[]): ModelResolution;
  getSupportedThinkingLevels(model: AvailableModel): string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tokens(value: string): string[] {
  return value.toLowerCase().trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function datedVersion(id: string): string | undefined {
  return id.match(/-(\d{8})$/)?.[1];
}

function isAlias(id: string): boolean {
  return id.endsWith("-latest") || datedVersion(id) === undefined;
}

function fuzzyScore(model: AvailableModel, query: string): Omit<RankedModel, "model" | "providerModelId"> | undefined {
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  const full = `${model.provider}/${model.id}`.toLowerCase();
  if (id.includes(query)) return { score: 8000 + Math.round(1000 * query.length / id.length), match: "id" };
  if (full.includes(query)) return { score: 7800 + Math.round(1000 * query.length / full.length), match: "id" };
  if (name.includes(query)) return { score: 7000 + Math.round(1000 * query.length / name.length), match: "name" };
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return undefined;
  const fields = [tokens(id), tokens(name), tokens(model.provider), tokens(full)];
  const all = new Set(fields.flat());
  if (!queryTokens.every((token) => [...all].some((part) => part.includes(token)))) return undefined;
  const matchingFieldLengths = fields
    .filter((field) => queryTokens.every((token) => field.some((part) => part.includes(token))))
    .map((field) => field.join(" ").length);
  const targetLength = matchingFieldLengths.length > 0
    ? Math.min(...matchingFieldLengths)
    : Math.min(...fields.map((field) => field.join(" ").length).filter((length) => length > 0));
  const queryLength = queryTokens.join(" ").length;
  return { score: 5000 + Math.round(1000 * queryLength / Math.max(queryLength, targetLength)), match: "tokens" };
}

function compareFuzzyRank(left: RankedModel, right: RankedModel): number {
  const leftAlias = isAlias(left.model.id);
  const rightAlias = isAlias(right.model.id);
  if (leftAlias !== rightAlias) return leftAlias ? -1 : 1;
  if (!leftAlias) {
    const dateOrder = compareText(datedVersion(right.model.id) ?? "", datedVersion(left.model.id) ?? "");
    if (dateOrder !== 0) return dateOrder;
  }
  return right.score - left.score || compareText(left.providerModelId, right.providerModelId);
}

function sameFuzzyRank(left: RankedModel, right: RankedModel): boolean {
  const leftAlias = isAlias(left.model.id);
  const rightAlias = isAlias(right.model.id);
  return leftAlias === rightAlias &&
    (leftAlias || datedVersion(left.model.id) === datedVersion(right.model.id)) &&
    left.score === right.score;
}

function rank(queryInput: string, models: readonly AvailableModel[]): RankedModel[] {
  if (typeof queryInput !== "string") return [];
  const query = queryInput.trim().toLowerCase();
  if (!query) return [];
  const wrap = (model: AvailableModel, score: number, match: RankedModel["match"]): RankedModel => ({
    model,
    providerModelId: `${model.provider}/${model.id}`,
    score,
    match,
  });
  const exactProviderId = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === query)
    .map((model) => wrap(model, 10000, "exact-provider-id"));
  if (exactProviderId.length > 0) return exactProviderId.sort((a, b) => compareText(a.providerModelId, b.providerModelId));
  const exactId = models.filter((model) => model.id.toLowerCase() === query)
    .map((model) => wrap(model, 9000, "exact-id"));
  if (exactId.length > 0) return exactId.sort((a, b) => compareText(a.providerModelId, b.providerModelId));
  return models.flatMap((model) => {
    const scored = fuzzyScore(model, query);
    return scored ? [wrap(model, scored.score, scored.match)] : [];
  }).sort(compareFuzzyRank);
}

function resolve(query: string, models: readonly AvailableModel[]): ModelResolution {
  if (typeof query !== "string" || query.trim() === "") return { status: "invalid", matches: [] };
  const matches = rank(query, models);
  if (matches.length === 0) return { status: "not-found", matches };
  const best = matches[0];
  const winners = best.match === "exact-provider-id" || best.match === "exact-id"
    ? matches.filter((candidate) => candidate.score === best.score)
    : matches.filter((candidate) => sameFuzzyRank(candidate, best));
  if (winners.length !== 1) return { status: "ambiguous", matches: winners };
  return { status: "resolved", model: best.model, matches };
}

function getSupportedThinkingLevels(model: AvailableModel): string[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function createPuiModelResolver(): PuiModelResolver {
  return Object.freeze({ version: 1, rank, resolve, getSupportedThinkingLevels });
}

export function installPuiModelResolver(host: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>): PuiModelResolver {
  const existing = host[PUI_MODEL_RESOLVER_SYMBOL] as PuiModelResolver | undefined;
  if (existing !== undefined) {
    if (existing.version !== 1 || typeof existing.rank !== "function" || typeof existing.resolve !== "function" || typeof existing.getSupportedThinkingLevels !== "function") {
      throw new Error("PUI model resolver version collision");
    }
    return existing;
  }
  const resolver = createPuiModelResolver();
  host[PUI_MODEL_RESOLVER_SYMBOL] = resolver;
  return resolver;
}

export function getPuiModelResolver(host: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>): PuiModelResolver | undefined {
  const resolver = host[PUI_MODEL_RESOLVER_SYMBOL] as PuiModelResolver | undefined;
  return resolver?.version === 1 ? resolver : undefined;
}
