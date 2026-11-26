/**
 * Measures one trial from inside the session: every model call, every tool call, and what
 * Workflow Memory did.
 *
 * Model calls come from three places and each is counted where it happens:
 *   - the agent loop: one assistant message per call (`message_end`);
 *   - sfactory's own calls for decide()/ask() and for replay during workflow_save, which never
 *     pass through the agent loop and are reported on the sfactory telemetry channel;
 *   - decision model calls a codemode script makes with models.classify(), reported on the
 *     codemode tool result.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TELEMETRY } from "../../extensions/sfactory/index.ts";

export interface Tokens {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** USD at catalog prices, when the provider's models have a price. */
	cost: number;
}

export const zero = (): Tokens => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export function add(total: Tokens, usage: unknown, calls = 1): Tokens {
	const u = (usage ?? {}) as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
	total.calls += calls;
	total.input += u.input ?? 0;
	total.output += u.output ?? 0;
	total.cacheRead += u.cacheRead ?? 0;
	total.cacheWrite += u.cacheWrite ?? 0;
	total.cost += u.cost?.total ?? 0;
	return total;
}

export function sum(...parts: Tokens[]): Tokens {
	const total = zero();
	for (const part of parts) {
		total.calls += part.calls;
		total.input += part.input;
		total.output += part.output;
		total.cacheRead += part.cacheRead;
		total.cacheWrite += part.cacheWrite;
		total.cost += part.cost;
	}
	return total;
}

export interface WorkflowRun {
	workflow: string;
	version?: number;
	/** ok, escalated, failed, or refused (stale or modified, so it did not run). */
	status: string;
	reason?: string;
	calls?: number;
	effects?: number;
	decisions?: number;
	ms?: number;
}

export interface TrialMetrics {
	large: {
		/** Agent loop requests. */
		agent: Tokens;
		/** Of the agent loop: turns spent inspecting traces, reading the compile skill, or saving a workflow. */
		compile: Tokens;
		/** LLM answers to decide() while a workflow runs. */
		decide: Tokens;
		/** LLM answers to ask() while a workflow runs. */
		ask: Tokens;
		/** LLM judgments made while replaying a workflow during workflow_save. */
		replay: Tokens;
		/** Every large-model call of the trial: agent + decide + ask + replay. */
		total: Tokens;
	};
	decisionModel: {
		/** Calls sfactory made (shadow, serving, audit). */
		sfactory: Tokens;
		/** Calls a codemode script made directly with models.classify(). */
		codemode: Tokens;
		total: Tokens;
		/** Decisions the decision model answered alone or after a passed audit. */
		adopted: number;
		/** Decisions the LLM answered while the decision model was compared in the shadow. */
		shadow: number;
		/** Decision model answers the LLM also checked. */
		audits: number;
		/** Decisions that fell back to the LLM because confidence was below the threshold. */
		fallbacks: number;
		/** Shadowed or audited decisions on which the two disagreed. */
		disagreements: number;
		/** Decisions with no decision model in play. */
		llmOnly: number;
	};
	workflow: {
		saveCalls: number;
		saved: number;
		refused: number;
		/** Saves that produced version 2 or later. */
		repairs: number;
		/** Judgments that, during replay, came out differently than in the recorded run. */
		divergences: number;
		acquired: string[];
		runs: WorkflowRun[];
		escalations: number;
		failures: number;
		hints: number;
	};
	/** Promotions and demotions of decision sites during the trial. */
	siteTransitions: { workflow: string; site: string; from: string; to: string; tau: number; samples: number }[];
	tools: Record<string, { calls: number; errors: number; nested: number }>;
	/** Read attempts outside the trial directory that the jail blocked. */
	jailBlocks: number;
	turns: number;
	finalAnswer: string;
}

export interface Collector {
	extension: (pi: ExtensionAPI) => void;
	metrics: TrialMetrics;
	/** One line per notable event, for reading a trial afterwards. */
	transcript: Record<string, unknown>[];
	finish(): TrialMetrics;
}

const COMPILE_TOOLS = new Set(["workflow_trace", "workflow_save", "workflow_feedback"]);

export function createCollector(): Collector {
	const metrics: TrialMetrics = {
		large: { agent: zero(), compile: zero(), decide: zero(), ask: zero(), replay: zero(), total: zero() },
		decisionModel: { sfactory: zero(), codemode: zero(), total: zero(), adopted: 0, shadow: 0, audits: 0, fallbacks: 0, disagreements: 0, llmOnly: 0 },
		workflow: { saveCalls: 0, saved: 0, refused: 0, repairs: 0, divergences: 0, acquired: [], runs: [], escalations: 0, failures: 0, hints: 0 },
		siteTransitions: [],
		tools: {},
		jailBlocks: 0,
		turns: 0,
		finalAnswer: "",
	};
	const transcript: Record<string, unknown>[] = [];

	const extension = (pi: ExtensionAPI) => {
		pi.on("message_end", async (event) => {
			const message = event.message as { role?: string; usage?: unknown; content?: { type: string; text?: string; name?: string; arguments?: Record<string, unknown> }[] };
			if (message.role !== "assistant") return;
			add(metrics.large.agent, message.usage);
			metrics.turns++;
			const content = Array.isArray(message.content) ? message.content : [];
			const calls = content.filter((block) => block.type === "toolCall");
			const compiling = calls.some(
				(call) =>
					COMPILE_TOOLS.has(call.name ?? "") ||
					(call.name === "read" && String(call.arguments?.path ?? "").includes("workflow-compile")) ||
					// Traces are often inspected from a script.
					(call.name === "codemode" && /workflow_(trace|save|feedback)/.test(String(call.arguments?.code ?? ""))),
			);
			if (compiling) add(metrics.large.compile, message.usage);
			const text = content
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n")
				.trim();
			if (text) metrics.finalAnswer = text;
			transcript.push({ type: "assistant", text: text || undefined, calls: calls.map((call) => ({ name: call.name, args: call.arguments })) });
		});

		pi.on("tool_execution_end", async (event) => {
			const entry = (metrics.tools[event.toolName] ??= { calls: 0, errors: 0, nested: 0 });
			entry.calls++;
			if (event.isError) entry.errors++;
			if (event.parentToolCallId) entry.nested++;
			if (event.toolName === "workflow_save") metrics.workflow.saveCalls++;
			const text = (event.result?.content ?? []).map((block: { text?: string }) => block.text ?? "").join("\n");
			if (event.isError && /outside the trial directory|is not available in this experiment/.test(text)) metrics.jailBlocks++;
			if (!event.parentToolCallId) transcript.push({ type: "tool", name: event.toolName, error: event.isError || undefined, ms: event.durationMs, result: text.slice(0, 1500) });
			// Decision model calls a script made itself: codemode lists them with its nested calls.
			if (event.toolName === "codemode") {
				const nested = (event.result?.details?.calls ?? []) as { name: string; cost?: number }[];
				for (const call of nested) {
					if (call.name.startsWith("models.classify")) {
						metrics.decisionModel.codemode.calls++;
						metrics.decisionModel.codemode.cost += call.cost ?? 0;
					}
				}
			}
		});

		pi.on("tool_result", async (event) => {
			// Token counts of those calls arrive as the codemode result's usage.
			if (event.toolName === "codemode" && event.usage) {
				const before = metrics.decisionModel.codemode;
				const { calls, cost } = before;
				add(before, event.usage, 0);
				before.calls = calls;
				before.cost = Math.max(cost, before.cost);
			}
		});

		pi.events.on(TELEMETRY, (data) => {
			const event = data as Record<string, any>;
			transcript.push({ type: "sfactory", ...event, usage: undefined });
			if (event.type === "model_call") {
				if (event.role === "classifier") add(metrics.decisionModel.sfactory, event.usage);
				else if (event.phase === "replay") add(metrics.large.replay, event.usage);
				else add(event.role === "ask_llm" ? metrics.large.ask : metrics.large.decide, event.usage);
			} else if (event.type === "decision") {
				// Judgments made during replay are validation, not use; their model calls are counted above.
				if (event.phase !== "run") return;
				const dm = metrics.decisionModel;
				if (event.path === "llm_only") dm.llmOnly++;
				if (event.path === "shadow") dm.shadow++;
				if (event.path === "s1_audit") dm.audits++;
				if (event.path === "s1_fallback") dm.fallbacks++;
				if (event.by === "s1") dm.adopted++;
				if (event.agreed === false) dm.disagreements++;
				if (event.tierBefore !== event.tierAfter) {
					metrics.siteTransitions.push({ workflow: event.workflow, site: event.site, from: event.tierBefore, to: event.tierAfter, tau: event.tau, samples: event.samples });
				}
			} else if (event.type === "save") {
				metrics.workflow.divergences += event.divergences ?? 0;
				if (event.outcome === "saved") {
					metrics.workflow.saved++;
					metrics.workflow.acquired.push(`${event.workflow}@v${event.version}`);
					if (event.version > 1) metrics.workflow.repairs++;
				} else metrics.workflow.refused++;
			} else if (event.type === "run") {
				metrics.workflow.runs.push({
					workflow: event.workflow,
					version: event.version,
					status: event.status,
					reason: event.reason,
					calls: event.calls,
					effects: event.effects,
					decisions: event.decisions,
					ms: event.ms,
				});
				if (event.status === "escalated") metrics.workflow.escalations++;
				if (event.status === "failed") metrics.workflow.failures++;
			} else if (event.type === "hint") metrics.workflow.hints++;
		});
	};

	return {
		extension,
		metrics,
		transcript,
		finish() {
			metrics.large.total = sum(metrics.large.agent, metrics.large.decide, metrics.large.ask, metrics.large.replay);
			metrics.decisionModel.total = sum(metrics.decisionModel.sfactory, metrics.decisionModel.codemode);
			return metrics;
		},
	};
}
