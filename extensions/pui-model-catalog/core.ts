import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installPuiModelResolver, type PuiModelResolver } from "./resolver.ts";

interface TypeApi {
  Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  String(options?: Record<string, unknown>): unknown;
  Optional(schema: unknown): unknown;
}

type ModelCatalogPi = Pick<ExtensionAPI, "registerTool">;
type AvailableModel = Model<any>;

function fallbackType(): TypeApi {
  return {
    Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
    String: (options = {}) => ({ type: "string", ...options }),
    Optional: (schema) => schema,
  };
}

function serializeModel(model: AvailableModel, resolver: PuiModelResolver) {
  const cost = {
    input: model.cost.input,
    output: model.cost.output,
    cacheRead: model.cost.cacheRead,
    cacheWrite: model.cost.cacheWrite,
    ...(model.cost.tiers ? { tiers: model.cost.tiers.map((tier) => ({ ...tier })) } : {}),
  };
  return {
    provider: model.provider,
    id: model.id,
    providerModelId: `${model.provider}/${model.id}`,
    name: model.name,
    api: model.api,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    capabilities: { input: [...model.input], reasoning: model.reasoning },
    costUsdPerMillionTokens: cost,
    reasoningEfforts: resolver.getSupportedThinkingLevels(model),
  };
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerPuiModelCatalog(
  pi: ModelCatalogPi,
  options: { Type?: TypeApi } = {},
): void {
  const Type = options.Type ?? fallbackType();
  const resolver = installPuiModelResolver();
  pi.registerTool({
    name: "model_list",
    label: "List models",
    promptSnippet: "List currently available models and rank fuzzy model names",
    description: "List models currently available through configured PUI provider authentication, grouped by provider. Returns each exact provider/model ID plus context limits, capabilities, USD-per-million-token costs, and provider-supported reasoning efforts. With a fuzzy query, the matches array preserves global rank and includes rank, exact provider/model ID, score, and match type before another tool receives an exact ID.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, description: "Optional case-insensitive fuzzy query ranked across provider, model ID, exact provider/model ID, and display name." })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const query = params.query;
      if (query !== undefined && (typeof query !== "string" || query.trim() === "")) throw new Error("query must be a non-empty string");
      const available = ctx.modelRegistry.getAvailable();
      const ranked = query === undefined ? undefined : resolver.rank(query, available);
      const selected = ranked === undefined
        ? [...available].sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id))
        : ranked.map((candidate) => candidate.model);
      const providers = new Map<AvailableModel["provider"], ReturnType<typeof serializeModel>[]>();
      for (const model of selected) {
        const models = providers.get(model.provider) ?? [];
        models.push(serializeModel(model, resolver));
        providers.set(model.provider, models);
      }
      return text({
        ...(query === undefined ? {} : {
          query,
          matches: ranked?.map((candidate, index) => ({
            rank: index + 1,
            providerModelId: candidate.providerModelId,
            score: candidate.score,
            match: candidate.match,
          })),
        }),
        totalModels: selected.length,
        providers: [...providers].map(([id, models]) => ({
          id,
          displayName: ctx.modelRegistry.getProviderDisplayName(id),
          models,
        })),
      });
    },
  });
}
