/**
 * sfactory: Workflow Memory for Pi.
 *
 * A workflow is a Pi tool whose implementation is a JavaScript file that runs in the codemode
 * sandbox. This extension records agent runs, admits workflows compiled from them through a replay
 * gate, and runs admitted workflows with a decision cascade behind `decide()`.
 *
 *   workflow_trace   list or inspect recorded runs (the raw material)
 *   workflow_save    admit a workflow: replay it against recorded runs, then register wf_<name>
 *   workflow_feedback  report that a workflow's result was wrong (or confirmed right)
 *   wf_<name>        run a saved workflow
 *   /wf              list, show, trust, retire, delete
 *
 * Environment:
 *   SFACTORY_DECIDE=auto|llm     auto (default) shadows the decision model and promotes per site
 *   SFACTORY_CLASSIFIER=p/id     decision model; default: the first available one
 *   SFACTORY_ASK_MODEL=p/id      chat model for decide()/ask(); default: the session's model
 *   SFACTORY_MIN_SAMPLES=n       shadow samples before a decision site may be promoted (default 20)
 *   SFACTORY_TERMINATE=1         end the turn after a successful trusted workflow (no summary call)
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { parseCodemodeSource } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import {
	ASK_SYSTEM,
	buildAskPrompt,
	buildDecidePrompt,
	type CascadeConfig,
	DECIDE_SYSTEM,
	DEFAULT_CASCADE,
	decideCascade,
	parseAsk,
	parseDecide,
} from "./src/decide.ts";
import { type Host, runWorkflow, type ToolDecl } from "./src/engine.ts";
import { replayFixture } from "./src/replay.ts";
import { hashTools, NAME_PATTERN, sha256, similarity, stamp, TraceStore, traceToFixture, WorkflowStore } from "./src/store.ts";
import {
	type CallRecord,
	type DecideQuestion,
	type DecideValue,
	type Fixture,
	preview,
	type RunResult,
	type SiteState,
	type Trace,
	type WorkflowMeta,
} from "./src/types.ts";

const STORE_DIR = join(".pi", "workflows");
const TRACE_DIR = join(".pi", "traces");
/** Tools that are never recorded and never available inside a workflow. */
const INTERNAL = (name: string) => name === "codemode" || name === "tool_search" || name.startsWith("wf_") || name.startsWith("workflow_");
const BUILTIN_READ_ONLY = new Set(["read", "grep", "find", "ls"]);
/** Consecutive successful runs before a workflow is trusted. */
const TRUST_AFTER = 3;
const SIMILAR = 0.5;

type Usage = Record<string, unknown>;

/** Sum two usage objects field by field, including the nested cost. */
function addUsage(total: Usage | undefined, add: unknown): Usage | undefined {
	if (!add || typeof add !== "object") return total;
	const out: Usage = { ...(total ?? {}) };
	for (const [key, value] of Object.entries(add)) {
		if (typeof value === "number") out[key] = (typeof out[key] === "number" ? (out[key] as number) : 0) + value;
		else if (value && typeof value === "object") out[key] = addUsage(out[key] as Usage | undefined, value);
	}
	return out;
}

function textOf(content: readonly { type: string; text?: string }[] | undefined): string {
	return (content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

export default function sfactory(pi: ExtensionAPI) {
	const stores = new Map<string, { workflows: WorkflowStore; traces: TraceStore }>();
	const storesFor = (cwd: string) => {
		let entry = stores.get(cwd);
		if (!entry) {
			entry = { workflows: new WorkflowStore(join(cwd, STORE_DIR)), traces: new TraceStore(join(cwd, TRACE_DIR)) };
			stores.set(cwd, entry);
		}
		return entry;
	};

	const cascadeConfig = (): CascadeConfig => ({
		...DEFAULT_CASCADE,
		mode: process.env.SFACTORY_DECIDE === "llm" ? "llm" : "auto",
		minSamples: Number(process.env.SFACTORY_MIN_SAMPLES) || DEFAULT_CASCADE.minSamples,
	});

	const isReadOnly = (name: string) =>
		BUILTIN_READ_ONLY.has(name) || pi.getAllTools().find((tool) => tool.name === name)?.annotations?.readOnlyHint === true;

	// ---------------------------------------------------------------------------------------------
	// Trace recorder: every leaf tool call of an agent run, with its result.
	// ---------------------------------------------------------------------------------------------

	/** Tool call ids of workflow runs in progress. Calls nested under them belong to the workflow. */
	const activeRuns = new Set<string>();
	const rootOf = (toolCallId: string) => toolCallId.split("/")[0];
	let current: Trace | undefined;
	const hinted = new Set<string>();
	/** A recorded run by id. "current" (or the id of the run in progress) is the run so far. */
	const loadTrace = (cwd: string, id: string): Trace | undefined => {
		if (current && (id === "current" || id === current.id)) return structuredClone(current);
		return storesFor(cwd).traces.load(id);
	};

	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = event.messageType === "user" ? event.prompt : "";
		current = {
			id: `t-${stamp()}`,
			prompt,
			startedAt: new Date().toISOString(),
			turns: 0,
			tokens: { input: 0, output: 0, cost: 0 },
			calls: [],
		};
		if (!prompt) return;

		// A nudge, not a router: tell the model when this request resembles a recorded cold run that
		// no workflow covers yet. It decides whether compiling is worth it.
		const { traces } = storesFor(ctx.cwd);
		const match = traces
			.list()
			.filter((trace) => !trace.usedWorkflow && trace.calls.length >= 3 && !hinted.has(trace.id))
			.map((trace) => ({ trace, score: similarity(prompt, trace.prompt) }))
			.sort((a, b) => b.score - a.score)[0];
		if (!match || match.score < SIMILAR) return;
		hinted.add(match.trace.id);
		return {
			message: {
				customType: "sfactory-hint",
				display: true,
				content:
					`[sfactory] This request resembles an earlier run (${match.trace.id}: "${preview(match.trace.prompt, 120)}", ` +
					`${match.trace.calls.length} tool calls, ${match.trace.turns} model turns). If no wf_* tool covers it, solve it as usual, ` +
					"then compile both runs into a workflow with workflow_trace and workflow_save so the next one is cheap.",
			},
		};
	});

	pi.on("turn_end", async (event) => {
		if (!current) return;
		current.turns++;
		const usage = (event.message as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage;
		if (usage) {
			current.tokens.input += usage.input ?? 0;
			current.tokens.output += usage.output ?? 0;
			current.tokens.cost += usage.cost?.total ?? 0;
		}
	});

	pi.on("tool_result", async (event) => {
		if (!current) return;
		if (event.toolName.startsWith("wf_") && !event.parentToolCallId) current.usedWorkflow = event.toolName.slice(3);
		if (INTERNAL(event.toolName) || activeRuns.has(rootOf(event.toolCallId))) return;
		const text = textOf(event.content);
		const record: CallRecord = {
			seq: current.calls.length + 1,
			tool: event.toolName,
			args: event.input,
			ok: !event.isError,
			readOnly: isReadOnly(event.toolName),
		};
		if (event.isError) record.error = text || "tool failed";
		else record.value = event.structuredContent !== undefined ? event.structuredContent : text;
		current.calls.push(record);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const trace = current;
		current = undefined;
		if (trace && trace.calls.length >= 2) storesFor(ctx.cwd).traces.write(trace);
	});

	// ---------------------------------------------------------------------------------------------
	// Guards: the store is written only through the gate, and a workflow cannot rewrite workflows.
	// ---------------------------------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		const nested = activeRuns.has(rootOf(event.toolCallId)) && event.toolCallId.includes("/");
		if (nested && INTERNAL(event.toolName)) {
			return { block: true, reason: `${event.toolName} cannot be called from inside a workflow` };
		}
		const root = resolve(ctx.cwd, STORE_DIR);
		const inside = (path: unknown) => {
			if (typeof path !== "string") return false;
			const rel = relative(root, resolve(ctx.cwd, path.replace(/^@/, "")));
			return !rel.startsWith("..") && !isAbsolute(rel);
		};
		const input = event.input as { path?: unknown; command?: unknown };
		const viaFileTool = (event.toolName === "write" || event.toolName === "edit") && inside(input.path);
		// Best effort for shells: a command that names the store and looks like it changes files.
		const viaShell =
			(event.toolName === "bash" || event.toolName === "powershell") &&
			typeof input.command === "string" &&
			/\.pi[\\/]+workflows/.test(input.command) &&
			/(^|[\s;&|(])(rm|mv|cp|tee|touch|mkdir|chmod|ln|truncate|dd|sed\s+-i|perl\s+-[a-z]*i)\b|>/.test(input.command);
		if (viaFileTool || viaShell) {
			return { block: true, reason: `${STORE_DIR} is managed by sfactory: change workflows with workflow_save, which validates them.` };
		}
	});

	// ---------------------------------------------------------------------------------------------
	// Judgments: the live side of decide() and ask().
	// ---------------------------------------------------------------------------------------------

	interface Meter {
		usage: Usage | undefined;
	}

	function liveJudgments(ctx: ExtensionContext, sites: Record<string, SiteState>, config: CascadeConfig, meter: Meter): Pick<Host, "decide" | "ask"> {
		const registry = ctx.modelRegistry;
		const pick = (spec: string | undefined) => {
			const slash = spec?.indexOf("/") ?? -1;
			return spec && slash > 0 ? ([spec.slice(0, slash), spec.slice(slash + 1)] as const) : undefined;
		};

		const chat = async (system: string, prompt: string, signal: AbortSignal): Promise<string> => {
			const spec = pick(process.env.SFACTORY_ASK_MODEL);
			const model = (spec && registry.find(spec[0], spec[1])) || ctx.model;
			if (!model) throw new Error("decide()/ask() need a chat model: select one, or set SFACTORY_ASK_MODEL=provider/id");
			const message = await registry.complete(
				model,
				{ systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
				{ signal } as never,
			);
			meter.usage = addUsage(meter.usage, message.usage);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(`model call failed: ${message.errorMessage ?? message.stopReason}`);
			}
			return textOf(message.content as { type: string; text?: string }[]);
		};

		let classifier: Promise<unknown> | undefined;
		const findClassifier = () => {
			classifier ??= (async () => {
				const spec = pick(process.env.SFACTORY_CLASSIFIER);
				if (spec) return registry.findOfType("classifier", spec[0], spec[1]);
				return (await registry.getAvailableOfType("classifier"))[0];
			})().catch(() => undefined);
			return classifier;
		};

		const classify = async (q: DecideQuestion, signal: AbortSignal) => {
			const model = await findClassifier();
			if (!model) return undefined;
			const result = await registry.classify(
				model as never,
				{ state: q.state as never, questions: { q: { type: q.type, instructions: q.instructions, criteria: q.criteria } as never } },
				{ signal } as never,
			);
			meter.usage = addUsage(meter.usage, result.usage);
			const answer = result.stopReason === "stop" ? result.answers.q : undefined;
			if (!answer) return undefined;
			if (answer.type === "choice") return { answer: answer.choice as DecideValue, confidence: answer.confidence };
			if (answer.type === "bool") return { answer: answer.probability >= 0.5, confidence: Math.max(answer.probability, 1 - answer.probability) };
			return { answer: Math.round(answer.score), confidence: answer.confidence };
		};

		return {
			decide: (question, signal) =>
				decideCascade(
					question,
					{
						config,
						sites,
						classify: config.mode === "auto" ? classify : undefined,
						llm: async (q, s) => parseDecide(q, await chat(DECIDE_SYSTEM, buildDecidePrompt(q), s)),
					},
					signal,
				),
			ask: async (prompt, state, schema, signal) => parseAsk(await chat(ASK_SYSTEM, buildAskPrompt(prompt, state, schema), signal), schema),
		};
	}

	// ---------------------------------------------------------------------------------------------
	// Running a saved workflow: wf_<name>.
	// ---------------------------------------------------------------------------------------------

	function toolDecls(ctx: ExtensionToolContext, names: string[]): { decls: ToolDecl[]; missing: string[]; hash: string } {
		const decls: ToolDecl[] = [];
		const missing: string[] = [];
		const found: { name: string; parameters?: unknown }[] = [];
		for (const name of names) {
			const tool = ctx.tools.find((candidate) => candidate.name === name);
			if (!tool) {
				missing.push(name);
				continue;
			}
			found.push({ name, parameters: tool.parameters });
			decls.push({ name, description: tool.description, readOnly: isReadOnly(name) });
		}
		return { decls, missing, hash: hashTools(found) };
	}

	function describeRun(meta: WorkflowMeta, result: RunResult, journal?: string): string {
		const s1 = result.decisions.filter((d) => d.by === "s1").length;
		const judgments = result.decisions.length ? `, ${result.decisions.length} judgments (${s1} by the decision model)` : "";
		const lines = [`Workflow ${meta.name} v${meta.version} [${meta.status}] ${result.status} in ${result.ms} ms: ${result.calls.length} tool calls${judgments}.`];
		if (result.output) lines.push("", result.output);
		if (result.status === "ok") {
			if (result.value !== undefined) lines.push("", "Result:", typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 1));
			if (meta.status !== "trusted") {
				lines.push(
					"",
					`This workflow is on probation (${meta.stats.consecutiveOk}/${TRUST_AFTER} clean runs). Check the result against the request. ` +
						`If it is wrong, call workflow_feedback({ name: "${meta.name}", ok: false, note }) and finish the task yourself.`,
				);
			}
			return lines.join("\n");
		}
		lines.push("", `Reason: ${result.reason ?? "unknown"}`);
		if (result.state !== undefined) lines.push("State handed over:", JSON.stringify(result.state, null, 1));
		const done = result.calls.filter((call) => call.ok && !call.readOnly);
		if (done.length) {
			lines.push("", "Side effects already applied (do NOT repeat them):", ...done.map((call) => `- ${call.tool}(${preview(call.args, 240)})`));
		} else {
			lines.push("", "No side effects were applied.");
		}
		if (journal) lines.push("", `Full journal: ${journal}`);
		lines.push(
			"",
			"Finish the task with your ordinary tools from the current state. Afterwards, if the workflow itself should handle this case, " +
				"save a corrected version with workflow_save (add this run's trace as an example).",
		);
		return lines.join("\n");
	}

	function registerWorkflow(meta: WorkflowMeta) {
		const name = meta.name;
		pi.registerTool({
			name: `wf_${name}`,
			label: `Workflow: ${name}`,
			description: `${meta.description}\n(Saved workflow: runs a validated program instead of redoing the steps.)`,
			promptSnippet: preview(meta.description, 140),
			parameters: meta.inputSchema as never,
			exposure: meta.status === "retired" ? "hidden" : "direct",
			executionMode: "sequential",
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const { workflows } = storesFor(ctx.cwd);
				const loaded = workflows.load(name);
				if (!loaded || loaded.meta.status === "retired") throw new Error(`workflow ${name} is no longer available; solve the task with your ordinary tools`);
				if (!loaded.intact) {
					throw new Error(`workflow ${name} was modified outside workflow_save and will not run. Solve the task with your ordinary tools, then re-save it.`);
				}
				const { decls, missing, hash } = toolDecls(ctx, loaded.meta.tools);
				if (missing.length || hash !== loaded.meta.toolsHash) {
					workflows.updateMeta(name, (m) => {
						m.status = "candidate";
						m.stats.consecutiveOk = 0;
						m.stats.lastError = "stale";
					});
					const why = missing.length ? `tools are missing: ${missing.join(", ")}` : "the schema of a tool it uses has changed";
					throw new Error(`workflow ${name} is stale (${why}) and will not run. Solve the task with your ordinary tools, then re-validate it with workflow_save.`);
				}

				const meter: Meter = { usage: undefined };
				const sites = structuredClone(loaded.meta.sites);
				const judgments = liveJudgments(ctx, sites, cascadeConfig(), meter);
				const host: Host = {
					...judgments,
					async callTool(tool, args, toolSignal) {
						const outcome = await ctx.executeTool(tool, args, { signal: toolSignal });
						const text = textOf(outcome.result.content as { type: string; text?: string }[]);
						if (outcome.isError) throw new Error(text || `${tool} failed`);
						const structured = (outcome.result as { structuredContent?: unknown }).structuredContent;
						return structured !== undefined ? structured : text;
					},
				};

				activeRuns.add(toolCallId);
				let result: RunResult;
				try {
					result = await runWorkflow({ code: loaded.code, input: params, tools: decls, host, signal: signal ?? undefined });
				} finally {
					activeRuns.delete(toolCallId);
				}

				const meta = workflows.updateMeta(name, (m) => {
					m.sites = sites;
					m.stats.runs++;
					m.stats.lastUsed = new Date().toISOString();
					if (result.status === "ok") {
						m.stats.ok++;
						m.stats.consecutiveOk++;
						if (m.status === "candidate") m.status = "probation";
						if (m.status === "probation" && m.stats.consecutiveOk >= TRUST_AFTER) m.status = "trusted";
					} else if (result.status === "escalated") {
						// Declining an input it does not cover is correct behavior, not a defect.
						m.stats.escalated++;
						m.stats.lastError = result.reason;
					} else {
						m.stats.failed++;
						m.stats.consecutiveOk = 0;
						m.stats.lastError = result.reason;
						m.status = m.status === "trusted" ? "probation" : "candidate";
					}
				})!;

				let journal: string | undefined;
				if (result.status === "ok") workflows.addRunFixture(name, params, result);
				else journal = workflows.writeRunJournal(name, params, result);

				return {
					content: [{ type: "text", text: describeRun(meta, result, journal) }],
					details: { status: result.status, calls: result.calls.length, decisions: result.decisions.length, ms: result.ms },
					isError: result.status === "failed",
					usage: meter.usage as never,
					terminate: process.env.SFACTORY_TERMINATE === "1" && result.status === "ok" && meta.status === "trusted",
				};
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		for (const meta of storesFor(ctx.cwd).workflows.list()) {
			if (meta.status !== "retired") registerWorkflow(meta);
		}
	});

	// ---------------------------------------------------------------------------------------------
	// workflow_trace: the raw material.
	// ---------------------------------------------------------------------------------------------

	pi.registerTool({
		name: "workflow_trace",
		label: "Workflow traces",
		description:
			"List recorded agent runs, or show one run's tool calls with their arguments and results. " +
			"Recorded runs are the examples a workflow is compiled from and validated against.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: 'Trace id to show, or "current" for the run in progress. Omit to list recent runs.' })),
			seq: Type.Optional(Type.Number({ description: "With id: print the full result of this call instead of the overview." })),
		}),
		annotations: { readOnlyHint: true },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { traces } = storesFor(ctx.cwd);
			const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
			if (!params.id) {
				const rows = [...(current?.calls.length ? [current] : []), ...traces.list().slice(0, 20)];
				if (!rows.length) return say("No runs recorded yet.");
				return say(
					rows
						.map(
							(t) =>
								`${t.id}${t === current ? " (this run, in progress)" : ""}  ${t.calls.length} calls, ${t.turns} turns, ${t.tokens.input + t.tokens.output} tokens` +
								`${t.usedWorkflow ? `  [used wf_${t.usedWorkflow}]` : ""}\n    "${preview(t.prompt, 160)}"`,
						)
						.join("\n"),
				);
			}
			const trace = loadTrace(ctx.cwd, params.id);
			if (!trace) throw new Error(`no trace ${params.id}; call workflow_trace without id to list them`);
			if (params.seq !== undefined) {
				const call = trace.calls.find((c) => c.seq === params.seq);
				if (!call) throw new Error(`trace ${trace.id} has no call #${params.seq}`);
				return say(`#${call.seq} ${call.tool}(${JSON.stringify(call.args)})\n${preview(call.ok ? call.value : call.error, 20_000)}`);
			}
			const lines = [
				`Trace ${trace.id}: "${trace.prompt}"`,
				`${trace.turns} model turns, ${trace.tokens.input + trace.tokens.output} tokens. Calls marked EFFECT changed something; a workflow must reproduce them or list them in ignore.`,
				"",
				...trace.calls.map(
					(c) =>
						`#${c.seq} ${c.readOnly ? "read  " : "EFFECT"} ${c.tool}(${preview(c.args, 400)})\n      ${c.ok ? "→" : "✗"} ${preview(c.ok ? c.value : c.error, 400)}`,
				),
			];
			return say(lines.join("\n"));
		},
	});

	// ---------------------------------------------------------------------------------------------
	// workflow_save: the admission gate.
	// ---------------------------------------------------------------------------------------------

	pi.registerTool({
		name: "workflow_save",
		label: "Save workflow",
		description:
			"Save a reusable workflow compiled from recorded runs. The code is the body of an async JavaScript function that runs in the " +
			"codemode sandbox with `input`, `tools.<name>(args)`, `decide()`, `ask()`, `escalate()`, `text()` and `return`. Before saving, " +
			"the code is replayed against every example: each tool call must match a recorded call exactly (same tool, same arguments), and " +
			"every recorded EFFECT call must be reproduced unless listed in `ignore`. On success the workflow becomes the tool wf_<name>. " +
			"Read the workflow-compile skill first.",
		promptSnippet: "Save a validated, reusable workflow compiled from recorded runs",
		promptGuidelines: [
			"Before working on a multi-step task, check whether a wf_* tool's description covers it; if so call that tool instead of redoing the steps by hand.",
			"If a wf_* tool fails or escalates, continue from the state it reports with your ordinary tools and never repeat the side effects it lists as applied.",
			"Use workflow_save only for tasks that have recurred or that the user asks to make reusable, never for one-off work. Read the workflow-compile skill before writing a workflow.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Lowercase identifier, e.g. triage_tickets. The tool becomes wf_<name>." }),
			description: Type.String({
				description: "What the workflow does, when to use it, and when NOT to use it. This is all a future model sees when choosing it.",
			}),
			input_schema: Type.Record(Type.String(), Type.Unknown(), {
				description: 'JSON Schema of the workflow input, an object: { "type": "object", "properties": {...}, "required": [...] }',
			}),
			code: Type.String({ description: "Body of an async JavaScript function." }),
			examples: Type.Array(
				Type.Object({
					trace: Type.String({ description: 'Trace id from workflow_trace, or "current" for the run in progress' }),
					input: Type.Record(Type.String(), Type.Unknown(), { description: "The workflow input that corresponds to that run" }),
					ignore: Type.Optional(Type.Array(Type.Number(), { description: "seq of EFFECT calls that were exploration and need not be reproduced" })),
				}),
				{ description: "Recorded runs this workflow must reproduce. Two runs with different inputs show that it generalizes." },
			),
			drop_fixtures: Type.Optional(Type.Array(Type.String(), { description: "Ids of earlier fixtures that are obsolete and should no longer be enforced" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { workflows } = storesFor(ctx.cwd);
			if (!NAME_PATTERN.test(params.name)) throw new Error("name must be lowercase letters, digits and _, starting with a letter (2-40 characters)");
			if (params.description.trim().length < 30) throw new Error("description is too short: say what it does, when to use it, and when not to");
			if ((params.input_schema as { type?: unknown }).type !== "object") throw new Error('input_schema must be a JSON Schema with "type": "object"');
			try {
				parseCodemodeSource(params.code);
			} catch (error) {
				throw new Error(`code: ${(error as Error).message}`);
			}

			const previous = workflows.load(params.name);
			const dropped = new Set(params.drop_fixtures ?? []);
			const fixtures = new Map<string, Fixture>();
			for (const fixture of previous ? workflows.fixtures(params.name) : []) {
				if (!dropped.has(fixture.id)) fixtures.set(fixture.id, fixture);
			}
			for (const example of params.examples) {
				const trace = loadTrace(ctx.cwd, example.trace);
				if (!trace) throw new Error(`no trace ${example.trace}; call workflow_trace to list recorded runs`);
				fixtures.set(trace.id, traceToFixture(trace, example.input, example.ignore ?? []));
			}
			if (!fixtures.size) throw new Error("at least one example is required: a workflow is only admitted for behavior that was observed");

			const names = [...new Set([...fixtures.values()].flatMap((fixture) => fixture.calls.map((call) => call.tool)))].filter((name) => !INTERNAL(name));
			const { decls, missing, hash } = toolDecls(ctx, names);
			if (missing.length) throw new Error(`the examples use tools that are not available now: ${missing.join(", ")}`);

			// Validation asks the LLM for every judgment, so a pass does not depend on calibration state.
			const meter: Meter = { usage: undefined };
			const judgments = liveJudgments(ctx, {}, { ...cascadeConfig(), mode: "llm" }, meter);
			const reports = [];
			for (const fixture of fixtures.values()) {
				reports.push(await replayFixture(params.code, fixture, decls, judgments, { signal: signal ?? undefined }));
			}
			const failed = reports.filter((report) => !report.pass);
			if (failed.length) {
				return {
					content: [
						{
							type: "text",
							text:
								`NOT SAVED: ${failed.length} of ${reports.length} example(s) failed replay.\n\n${reports.map((r) => r.summary).join("\n\n")}\n\n` +
								"Fix the code so its tool calls match the recorded ones exactly (inspect them with workflow_trace), " +
								"list exploratory EFFECT calls in `ignore`, or drop an obsolete fixture with `drop_fixtures`.",
						},
					],
					details: undefined,
					isError: true,
					usage: meter.usage as never,
				};
			}

			const warnings: string[] = [];
			const inputs = new Set([...fixtures.values()].map((fixture) => JSON.stringify(fixture.input)));
			if (inputs.size < 2) warnings.push("Only one distinct input was replayed, so generalization is unverified. Add a second example with a different input when the task recurs.");
			const literals = new Set<string>();
			const collect = (value: unknown) => {
				if (typeof value === "string" && value.length >= 3) literals.add(value);
				else if (value && typeof value === "object") Object.values(value).forEach(collect);
			};
			for (const fixture of fixtures.values()) collect(fixture.input);
			const hardCoded = [...literals].filter((literal) => params.code.includes(literal));
			if (hardCoded.length) warnings.push(`The code contains input values literally (${hardCoded.slice(0, 5).map((v) => JSON.stringify(v)).join(", ")}): read them from \`input\` instead.`);

			const now = new Date().toISOString();
			const meta: WorkflowMeta = {
				name: params.name,
				description: params.description.trim(),
				inputSchema: params.input_schema,
				tools: decls.map((decl) => decl.name),
				toolsHash: hash,
				sha256: sha256(params.code),
				version: (previous?.meta.version ?? 0) + 1,
				status: "candidate",
				createdAt: previous?.meta.createdAt ?? now,
				updatedAt: now,
				stats: { ...(previous?.meta.stats ?? { runs: 0, ok: 0, failed: 0, escalated: 0 }), consecutiveOk: 0 },
				sites: previous?.meta.sites ?? {},
				notes: previous?.meta.notes ?? [],
			};
			workflows.save(meta, params.code, [...fixtures.values()]);
			registerWorkflow(meta);

			return {
				content: [
					{
						type: "text",
						text: [
							`Saved ${meta.name} v${meta.version} as tool wf_${meta.name} [candidate]. Replay passed on ${reports.length} example(s):`,
							...reports.map((r) => `  ${r.summary}`),
							`Allowed tools: ${meta.tools.join(", ") || "(none)"}.`,
							...warnings.map((w) => `Warning: ${w}`),
							`It becomes trusted after ${TRUST_AFTER} clean runs.`,
						].join("\n"),
					},
				],
				details: undefined,
				usage: meter.usage as never,
			};
		},
	});

	// ---------------------------------------------------------------------------------------------
	// workflow_feedback and /wf.
	// ---------------------------------------------------------------------------------------------

	pi.registerTool({
		name: "workflow_feedback",
		label: "Workflow feedback",
		description:
			"Report whether a workflow's result was right. ok: false demotes the workflow and records why, so it is fixed before it is trusted again. " +
			"Use it when a wf_* result turns out to be wrong or the user corrects it.",
		parameters: Type.Object({
			name: Type.String(),
			ok: Type.Boolean(),
			note: Type.Optional(Type.String({ description: "What was wrong, or what was confirmed" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const meta = storesFor(ctx.cwd).workflows.updateMeta(params.name.replace(/^wf_/, ""), (m) => {
				if (params.note) m.notes = [...m.notes, `${new Date().toISOString().slice(0, 10)} ${params.ok ? "ok" : "WRONG"}: ${params.note}`].slice(-20);
				if (!params.ok) {
					m.status = "candidate";
					m.stats.consecutiveOk = 0;
					m.stats.lastError = params.note ?? "reported wrong";
				}
			});
			if (!meta) throw new Error(`no workflow ${params.name}`);
			return { content: [{ type: "text", text: `${meta.name} is now ${meta.status}.` }], details: undefined };
		},
	});

	pi.registerCommand("wf", {
		description: "Workflow Memory: /wf [list | show <name> | trust <name> | retire <name> | delete <name>]",
		handler: async (args, ctx) => {
			const { workflows } = storesFor(ctx.cwd);
			const [action = "list", name] = args.trim().split(/\s+/).filter(Boolean);
			const say = (text: string, level: "info" | "warning" = "info") => ctx.ui.notify(text, level);
			if (action === "list") {
				const metas = workflows.list();
				return say(
					metas.length
						? metas
								.map((m) => {
									const s1 = Object.values(m.sites).filter((site) => site.tier === "s1").length;
									return `wf_${m.name} v${m.version} [${m.status}] runs ${m.stats.ok}/${m.stats.runs} ok, ${m.stats.escalated} escalated, decision sites ${s1}/${Object.keys(m.sites).length} on the decision model`;
								})
								.join("\n")
						: "No workflows saved yet.",
				);
			}
			if (!name) return say(`usage: /wf ${action} <name>`, "warning");
			const loaded = workflows.load(name.replace(/^wf_/, ""));
			if (!loaded) return say(`no workflow ${name}`, "warning");
			const id = loaded.meta.name;
			if (action === "show") return say(`${JSON.stringify(loaded.meta, null, 1)}\n\n${loaded.code}`);
			if (action === "trust") {
				workflows.updateMeta(id, (m) => {
					m.status = "trusted";
				});
				return say(`${id} is now trusted.`);
			}
			if (action === "retire" || action === "delete") {
				const meta = workflows.updateMeta(id, (m) => {
					m.status = "retired";
				})!;
				registerWorkflow(meta);
				if (action === "delete") workflows.remove(id);
				return say(`${id} ${action === "delete" ? "deleted" : "retired"}.`);
			}
			return say("usage: /wf [list | show <name> | trust <name> | retire <name> | delete <name>]", "warning");
		},
	});
}
