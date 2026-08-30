import type { AgentToolResult, ExtensionContext, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { AgentSpawnConfig } from "#src/lifecycle/subagent-manager";
import { spawnBackground } from "#src/tools/background-spawner";
import { runForeground } from "#src/tools/foreground-runner";
import { buildAgentGuidelines, buildDetails, buildTypeListText, textResult } from "#src/tools/helpers";
import { renderAgentResult } from "#src/tools/result-renderer";
import { type ModelInfo, resolveSpawnConfig } from "#src/tools/spawn-config";
import type { ParentSessionInfo, Subagent } from "#src/types";
import { type AgentDetails, getDisplayName, type Theme } from "#src/ui/display";
import { GLYPHS } from "#src/ui/glyphs";

// ---- Deps interfaces ----

/** Narrow manager interface — only the methods the Agent tool calls. */
export interface AgentToolManager {
	spawn: (snapshot: ParentSnapshot, type: string, prompt: string, opts: AgentSpawnConfig) => string;
	spawnAndWait: (snapshot: ParentSnapshot, type: string, prompt: string, opts: Omit<AgentSpawnConfig, "isBackground">) => Promise<Subagent>;
	resume: (id: string, prompt: string, signal: AbortSignal) => Promise<Subagent | undefined>;
	getRecord: (id: string) => Subagent | undefined;
}

/** Narrow runtime interface — the Agent tool's slice of SubagentRuntime. */
export interface AgentToolRuntime {
	buildSnapshot(inheritContext: boolean): ParentSnapshot;
	getModelInfo(): ModelInfo;
	getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}

/** Narrow settings accessor — only the fields the Agent tool reads. */
export type AgentToolSettings = {
	readonly defaultMaxTurns: number | undefined;
	readonly maxConcurrent: number;
};

// ---- Class ----

// pui-subagents-patch:policy-v7
export class AgentTool {
	private readonly typeListText: string;
	private readonly availableTypesText: string;
	private readonly agentGuidelines: string[];

	constructor(
		private readonly manager: AgentToolManager,
		private readonly runtime: AgentToolRuntime,
		private readonly settings: AgentToolSettings,
		private readonly registry: AgentTypeRegistry,
		private readonly agentDir: string,
	) {
		this.typeListText = buildTypeListText(registry, agentDir);
		this.availableTypesText = registry.getAvailableTypes().join(", ");
		this.agentGuidelines = buildAgentGuidelines(registry);
	}

	async execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
		_ctx: ExtensionContext,
	) {
		// Reload custom agents so new .pi/agents/*.md files are picked up without restart
		this.registry.reload();

		// Resume is ID-driven. New-spawn profile, model, turn, background, and
		// context parameters must not block or silently alter an existing session.
		if (params.resume) {
			const existing = this.manager.getRecord(params.resume as string);
			if (!existing) {
				return textResult(
					`Agent not found: "${params.resume as string}". Records are cleared at session start/switch, so it may be from a previous session.`,
				);
			}
			if (!existing.isSessionReady()) {
				if (existing.sessionReleased) {
					return textResult(
						`Agent "${params.resume as string}" had its session released after its retention window; resume is unavailable, but its result is still retrievable via get_subagent_result.`,
					);
				}
				return textResult(`Agent "${params.resume as string}" has no active session to resume.`);
			}
			const record = await this.manager.resume(
				params.resume as string,
				params.prompt as string,
				signal ?? new AbortController().signal,
			);
			if (!record) return textResult(`Failed to resume agent "${params.resume as string}".`);
			record.markConsumed();
			return textResult(
				record.result?.trim() ?? record.error?.trim() ?? "No output.",
				buildDetails({
					displayName: getDisplayName(existing.type, this.registry),
					description: existing.description,
					subagentType: existing.type,
					modelName: existing.invocation?.modelName,
					tags: [],
				}, record),
			);
		}

		if (typeof params.subagent_type !== "string" || params.subagent_type.trim() === "") {
			return textResult("subagent_type is required when starting a new agent.");
		}

		// ---- Config resolution (pure) ----
		const config = resolveSpawnConfig(
			params,
			this.registry,
			this.runtime.getModelInfo(),
			this.settings,
		);
		if ("error" in config) return textResult(config.error);

		// ---- Boundary extraction (after config so inheritContext is resolved) ----
		const snapshot = this.runtime.buildSnapshot(config.execution.inheritContext);
		const { parentSessionFile, parentSessionId } = this.runtime.getSessionInfo();
		const parentSession: ParentSessionInfo = { parentSessionFile, parentSessionId, toolCallId };

		// ---- Background execution ----
		if (config.execution.runInBackground) {
			return spawnBackground(
				this.manager,
				{ config, snapshot, parentSession, settings: this.settings },
			);
		}

		// ---- Foreground execution — stream progress via onUpdate ----
		return runForeground(
			this.manager,
			{ config, snapshot, parentSession },
			signal,
			onUpdate,
		);
	}

	toToolDefinition() {
		const typeListText = this.typeListText;
		const availableTypesText = this.availableTypesText;
		const agentDir = this.agentDir;
		const registry = this.registry;

		const guidelines = [
			"- Foreground calls wait for their result and run sequentially. Use foreground when the next parent action depends on that result; use run_in_background: true when useful independent work can proceed before collection.",
			"- Run background agents in parallel only when their tracks are independent and do not overlap writes or other shared mutable state.",
			"- You own user intent, user-owned decisions, overall architecture and planning, decomposition, synthesis, integration, final verification, and the final response.",
			"- Delegate only bounded work when context isolation, independent parallelism, restricted capabilities, or substantial intermediate output justifies it. Do quick work directly.",
			"- Default routes: local static evidence → Explore; external/current evidence → Research; decided execution → Worker; judgment/synthesis/architecture/planning → main. An overridden name is custom; follow its listed description.",
			"- For mixed local and external work, run independent Explore and Research tracks in parallel when possible; if one depends on the other, sequence them through main and pass only the needed context. Do not chain children.",
			"- Subagent results are evidence or work products. You remain responsible for synthesis and acceptance.",
			"- Collect every required result before dependent decisions, edits, or synthesis. Treat errors, aborts, stopped/max-turn status, and partial output as incomplete; retry only with new information or direction, reassign, or report the gap.",
			"- For background agents, use get_subagent_result after the completion notification or when the result is needed. To continue retained context, set resume to its agent ID and provide only the new prompt; omit spawn-only parameters.",
			"- Route to a custom agent only when the user names it or its listed description is the best match. Prompt with explicit task, scope, constraints, stated capabilities, success criteria, and output; assume no unlisted capability. Exact names added or changed during a session are reload-resolved at invocation.",
			...this.agentGuidelines,
			"- Subagent results are returned as text — summarize them for the user.",
			
			"- Resume only with new information or direction. Set resume to the agent ID, provide the new prompt, and omit subagent_type plus other spawn-only parameters.",
			"- Use steer_subagent to send mid-run messages to a running background agent.",
			"- Mandatory: Omit model unless the user explicitly requests a model override. PUI resolves an omitted model through the user's fuzzy model mappings when one matches the parent and otherwise inherits the parent model. Agent type, task, cost, speed, or your own judgment never authorize a model override.",
			"- Omit thinking unless the user explicitly requests a different reasoning level; omission inherits the parent session's active reasoning level.",
			"- Use inherit_context if the agent needs the parent conversation history.",
		].join("\n");

		return defineTool({
			name: "subagent" as const,
			label: "Subagent",
			promptSnippet: "Launch a specialized agent for bounded work.",
			description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The subagent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
${guidelines}
`,
			parameters: Type.Object({
				prompt: Type.String({
					description: "The delegated task. Follow the selected agent type's prompt recipe in Guidelines.",
				}),
				description: Type.Optional(
					Type.String({
						description: "A short (3-5 word) description of a new task (shown in UI). Omit when resuming.",
						minLength: 1,
					}),
				),
				subagent_type: Type.Optional(
					Type.String({
						description: `The type of specialized agent to use for a new agent. Use an exact listed name; unknown names fail closed. Available types: ${availableTypesText}. Custom agents from .pi/agents/<name>.md (project) or ${agentDir}/agents/<name>.md (global) are also available. Omit only when resuming by agent ID.`,
						minLength: 1,
					}),
				),
				model: Type.Optional(
					Type.String({
						description:
							'Model override. Set only when the user explicitly requests a different model; otherwise omit it to use a matching user-configured fuzzy model mapping or inherit the parent model. Accepts "provider/modelId" or a fuzzy name (e.g. "haiku", "sonnet").',
					}),
				),
				thinking: Type.Optional(
					Type.Union(
						[
							Type.Literal("off"),
							Type.Literal("minimal"),
							Type.Literal("low"),
							Type.Literal("medium"),
							Type.Literal("high"),
							Type.Literal("xhigh"),
						],
						{ description: "Reasoning-level override: off, minimal, low, medium, high, or xhigh. Set only when the user explicitly requests a different level; otherwise omit it to inherit the parent session's active reasoning level." },
					),
				),
				max_turns: Type.Optional(
					Type.Integer({
						description:
							"Maximum number of agentic turns before stopping. Omit for unlimited (default).",
						minimum: 1,
					}),
				),
				run_in_background: Type.Optional(
					Type.Boolean({
						description:
							"Execution mode for a new agent: true returns an agent ID immediately and runs in background; false waits for the result. Omit to use the profile default (PUI built-ins: false).",
					}),
				),
				resume: Type.Optional(
					Type.String({
						description: "Optional agent ID to resume from. Continues from previous context.",
					}),
				),
				inherit_context: Type.Optional(
					Type.Boolean({
						description:
							"If true, fork parent conversation into the agent. Default: false (fresh context).",
					}),
				),
			}),

			// ---- Custom rendering: inline subagent results ----

			renderCall(args: Record<string, unknown>, theme: Theme) {
				const displayName = args.subagent_type
					? getDisplayName(args.subagent_type as string, registry)
					: "Subagent";
				const desc = (args.description as string | undefined) ?? "";
				return new Text(
					`${GLYPHS.toolCall} ` +
						theme.fg("toolTitle", theme.bold(displayName)) +
						(desc ? "  " + theme.fg("muted", desc) : ""),
					0,
					0,
				);
			},

			renderResult(
				result: AgentToolResult<AgentDetails | undefined>,
				{ expanded, isPartial }: ToolRenderResultOptions,
				theme: Theme,
			) {
				const details = result.details;
				if (!details) {
					const text = result.content[0]?.type === "text" ? result.content[0].text : "";
					return new Text(text, 0, 0);
				}
				const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(
					renderAgentResult(details, resultText, expanded, isPartial, theme),
					0,
					0,
				);
			},

			execute: (
				toolCallId: string,
				params: Record<string, unknown>,
				signal: AbortSignal | undefined,
				onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
				ctx: ExtensionContext,
			) => this.execute(toolCallId, params, signal, onUpdate, ctx),
		});
	}
}
