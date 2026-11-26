/**
 * Runs one workflow: plain JavaScript in Pi's codemode sandbox (QuickJS), with only the allowed
 * tools injected plus `input`, `decide()`, `ask()` and `escalate()`.
 *
 * The engine knows nothing about Pi sessions. A `Host` answers tool calls and judgments, so the same
 * engine runs a workflow live and replays it against a recorded fixture.
 */
import { CodemodeSandbox, type CodemodeTool, parseCodemodeSource } from "@earendil-works/pi-codemode";
import {
	type CallRecord,
	type DecideAnswer,
	type DecideQuestion,
	type DecisionRecord,
	EscalateError,
	type RunResult,
	StopError,
} from "./types.ts";

export interface ToolDecl {
	name: string;
	description?: string;
	readOnly: boolean;
}

export interface Host {
	/** Resolves to what the script receives; rejects with the tool's error text. */
	callTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
	decide(question: DecideQuestion, signal: AbortSignal): Promise<DecideAnswer>;
	ask(prompt: string, state: unknown, schema: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface Budget {
	maxCalls: number;
	maxDecisions: number;
	timeoutMs: number;
}

export const DEFAULT_BUDGET: Budget = { maxCalls: 200, maxDecisions: 200, timeoutMs: 300_000 };

export interface RunOptions {
	code: string;
	input: unknown;
	tools: ToolDecl[];
	host: Host;
	budget?: Partial<Budget>;
	signal?: AbortSignal;
}

type Terminal = { status: "escalated" | "failed"; reason: string; state?: unknown };

export async function runWorkflow(options: RunOptions): Promise<RunResult> {
	const started = Date.now();
	const parsed = parseCodemodeSource(options.code);
	const budget: Budget = { ...DEFAULT_BUDGET, ...options.budget };
	if (parsed.options.timeoutMs !== undefined) budget.timeoutMs = Math.min(budget.timeoutMs, parsed.options.timeoutMs);

	const calls: CallRecord[] = [];
	const decisions: DecisionRecord[] = [];
	let seq = 0;

	// The first terminal condition wins and aborts the VM, so a script cannot catch and continue.
	const abort = new AbortController();
	const onExternalAbort = () => abort.abort();
	options.signal?.addEventListener("abort", onExternalAbort, { once: true });
	let terminal: Terminal | undefined;
	const stop = (next: Terminal): never => {
		terminal ??= next;
		abort.abort();
		throw new Error(next.reason);
	};
	/** Host errors that end the run. Anything else is an ordinary error the script may handle. */
	const rethrow = (error: unknown): never => {
		if (error instanceof EscalateError) stop({ status: "escalated", reason: error.message, state: error.state });
		if (error instanceof StopError) stop({ status: "failed", reason: error.message });
		throw error;
	};
	const guard = () => {
		if (terminal) throw new Error("workflow stopped");
	};
	const jsonSafe = (value: unknown) => (value === undefined ? null : value);

	const tools: CodemodeTool[] = options.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		execute: async (args, { signal }) => {
			guard();
			if (calls.length >= budget.maxCalls) {
				stop({ status: "failed", reason: `budget exceeded: more than ${budget.maxCalls} tool calls` });
			}
			const record: CallRecord = { seq: ++seq, tool: tool.name, args, ok: false, readOnly: tool.readOnly };
			calls.push(record);
			const t0 = Date.now();
			try {
				const value = jsonSafe(await options.host.callTool(tool.name, args, signal));
				record.ok = true;
				record.value = value;
				return value;
			} catch (error) {
				record.error = error instanceof Error ? error.message : String(error);
				return rethrow(error);
			} finally {
				record.ms = Date.now() - t0;
			}
		},
	}));

	const countDecision = () => {
		guard();
		if (decisions.length >= budget.maxDecisions) {
			stop({ status: "failed", reason: `budget exceeded: more than ${budget.maxDecisions} decide/ask calls` });
		}
	};

	const globals: CodemodeTool[] = [
		{
			name: "decide",
			execute: async (arg, { signal }) => {
				countDecision();
				const question = checkQuestion(arg);
				try {
					const answer = await options.host.decide(question, signal);
					decisions.push({
						seq: ++seq,
						kind: "decide",
						id: question.id,
						key: question.state,
						answer: answer.answer,
						by: answer.by,
						confidence: answer.confidence,
					});
					return answer;
				} catch (error) {
					return rethrow(error);
				}
			},
		},
		{
			name: "ask",
			spread: true,
			execute: async (args, { signal }) => {
				countDecision();
				const [prompt, state, schema] = args as [unknown, unknown, unknown];
				if (typeof prompt !== "string" || !prompt) throw new TypeError("ask(prompt, state, schema): prompt must be a string");
				try {
					const answer = jsonSafe(await options.host.ask(prompt, state ?? null, schema ?? null, signal));
					decisions.push({ seq: ++seq, kind: "ask", key: [prompt, state ?? null], answer, by: "s2" });
					return answer;
				} catch (error) {
					return rethrow(error);
				}
			},
		},
		{
			name: "escalate",
			spread: true,
			execute: (args) => {
				const [reason, state] = args as [unknown, unknown];
				return stop({ status: "escalated", reason: String(reason ?? "escalated by workflow"), state });
			},
		},
	];

	const sandbox = new CodemodeSandbox({ tools, globals, timeoutMs: budget.timeoutMs, memoryLimitBytes: 256 * 1024 * 1024 });
	try {
		// The prefix stays on line 1, so line numbers in stack traces match the saved file.
		const code = `const input = ${JSON.stringify(options.input ?? null)};${parsed.code}`;
		const result = await sandbox.execute(code, { signal: abort.signal });
		const output = result.output
			.filter((item) => item.type === "text")
			.map((item) => (item as { text: string }).text)
			.join("\n");
		const base = { output, calls, decisions, ms: Date.now() - started };
		if (terminal) return { ...base, status: terminal.status, reason: terminal.reason, state: terminal.state };
		if (result.ok) return { ...base, status: "ok", value: result.value };
		const reason =
			result.error.kind === "script"
				? (result.error.stack ?? result.error.message)
				: `${result.error.kind}: ${result.error.message}`;
		return { ...base, status: "failed", reason };
	} finally {
		options.signal?.removeEventListener("abort", onExternalAbort);
		await sandbox.close();
	}
}

function checkQuestion(arg: unknown): DecideQuestion {
	const q = arg as Partial<DecideQuestion> | null;
	const fail = (what: string): never => {
		throw new TypeError(`decide({ id, state, type, instructions, criteria }): ${what}`);
	};
	if (!q || typeof q !== "object") return fail("expects one object");
	if (typeof q.id !== "string" || !q.id) fail("id must be a non-empty string");
	if (!q.state || typeof q.state !== "object" || Array.isArray(q.state)) fail("state must be an object");
	if (typeof q.instructions !== "string" || !q.instructions) fail("instructions must be a string");
	if (q.type === "choice") {
		if (!q.criteria || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2) {
			fail("a choice needs criteria mapping at least two labels to their meaning");
		}
	} else if (q.type === "bool") {
		const c = q.criteria as Record<string, string> | undefined;
		if (!c || typeof c.true !== "string" || typeof c.false !== "string") fail("a bool needs criteria { true, false }");
	} else if (q.type === "score") {
		if (!Array.isArray(q.criteria) || q.criteria.length < 2) fail("a score needs criteria as an array of at least two levels");
	} else {
		fail('type must be "choice", "bool" or "score"');
	}
	return q as DecideQuestion;
}
