/**
 * The admission gate: run a workflow against a recorded execution without touching the world.
 *
 * Tool calls are answered from the recording and nothing else. A call the recording does not contain
 * ends the replay, so a workflow can only be admitted for behavior that was actually observed. After
 * the run, every recorded side effect must have been reproduced, unless it is listed as ignorable.
 *
 * Judgments (`decide`, `ask`) have no side effects. Recorded ones are reused; the rest are asked
 * live, which checks that the workflow's questions lead to the demonstrated outcome.
 */
import { type Budget, type Host, runWorkflow, type ToolDecl } from "./engine.ts";
import { type CallRecord, canon, type Fixture, preview, type RunResult, StopError } from "./types.ts";

export interface ReplayReport {
	fixture: string;
	pass: boolean;
	result: RunResult;
	/** Recorded side-effecting calls the workflow did not make. */
	missing: CallRecord[];
	summary: string;
}

export async function replayFixture(
	code: string,
	fixture: Fixture,
	tools: ToolDecl[],
	live: Pick<Host, "decide" | "ask">,
	options: { budget?: Partial<Budget>; signal?: AbortSignal } = {},
): Promise<ReplayReport> {
	const queues = new Map<string, CallRecord[]>();
	const byTool = new Map<string, CallRecord[]>();
	for (const call of fixture.calls) {
		const key = `${call.tool}\n${canon(call.args)}`;
		queues.set(key, [...(queues.get(key) ?? []), call]);
		byTool.set(call.tool, [...(byTool.get(call.tool) ?? []), call]);
	}
	const consumed = new Set<number>();
	const recorded = new Map<string, unknown[]>();
	for (const d of fixture.decisions) {
		const key = `${d.kind}\n${d.id ?? ""}\n${canon(d.key)}`;
		recorded.set(key, [...(recorded.get(key) ?? []), d]);
	}

	const host: Host = {
		async callTool(name, args) {
			const queue = queues.get(`${name}\n${canon(args)}`);
			// A repeated identical read reuses the last recording. A repeated side effect does not:
			// issuing one more often than observed is a mismatch.
			const last = queue?.at(-1);
			const call = queue?.find((c) => !consumed.has(c.seq)) ?? (last?.readOnly ? last : undefined);
			if (!call) {
				const seen = (byTool.get(name) ?? []).slice(0, 6).map((c) => `  #${c.seq} ${preview(c.args, 160)}`);
				throw new StopError(
					`replay mismatch in ${fixture.id}: ${name}(${preview(args, 200)}) was never observed.\n` +
						(seen.length ? `Observed ${name} calls:\n${seen.join("\n")}` : `No ${name} call was observed in this recording.`),
				);
			}
			consumed.add(call.seq);
			if (!call.ok) throw new Error(call.error ?? "tool failed");
			return call.value;
		},
		async decide(question, signal) {
			const hit = recorded.get(`decide\n${question.id}\n${canon(question.state)}`)?.[0] as
				| { answer: never; by?: "s1" | "s2"; confidence?: number }
				| undefined;
			if (hit) return { answer: hit.answer, by: hit.by ?? "s2", confidence: hit.confidence ?? 1 };
			return live.decide(question, signal);
		},
		async ask(prompt, state, schema, signal) {
			const hit = recorded.get(`ask\n\n${canon([prompt, state])}`)?.[0] as { answer: unknown } | undefined;
			if (hit) return hit.answer;
			return live.ask(prompt, state, schema, signal);
		},
	};

	const result = await runWorkflow({ code, input: fixture.input, tools, host, budget: options.budget, signal: options.signal });
	const ignore = new Set(fixture.ignore);
	const missing = fixture.calls.filter((c) => !c.readOnly && c.ok && !consumed.has(c.seq) && !ignore.has(c.seq));
	const pass = result.status === "ok" && missing.length === 0;

	const lines: string[] = [];
	if (result.status !== "ok") lines.push(`${result.status}: ${result.reason ?? "unknown"}`);
	if (missing.length) {
		lines.push(
			`${missing.length} recorded side effect(s) were not reproduced:`,
			...missing.slice(0, 12).map((c) => `  #${c.seq} ${c.tool}(${preview(c.args, 200)})`),
		);
	}
	const summary = pass
		? `${fixture.id}: PASS (${result.calls.length} calls, ${result.decisions.length} judgments)`
		: `${fixture.id}: FAIL\n${lines.join("\n")}`;
	return { fixture: fixture.id, pass, result, missing, summary };
}
