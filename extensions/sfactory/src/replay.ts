/**
 * The admission gate: run a workflow against a recorded execution without touching the world.
 *
 * Tool calls are answered from the recording and nothing else. A call the recording does not contain
 * ends the replay, so a workflow can only be admitted for behavior that was actually observed. After
 * the run, every recorded side effect must have been reproduced, unless it is listed as ignorable.
 *
 * Judgments (`decide`, `ask`) have no side effects and are asked live. A recording made by an agent
 * working by hand contains no judgments, only their consequences, and the same model does not
 * always judge the same way twice. So when a live answer leads to a side effect the recording does
 * not contain, the gate looks for the answer that does lead to the recorded one, continues with
 * it, and reports the difference. What the gate checks is the program: that some answers to its
 * questions reproduce the demonstration. A workflow whose questions rarely get the demonstrated
 * answer is still refused.
 */
import { type Budget, type Host, runWorkflow, type ToolDecl } from "./engine.ts";
import { type CallRecord, canon, type DecideQuestion, type DecideValue, EscalateError, type Fixture, preview, type RunResult, StopError } from "./types.ts";

/** A judgment where the live answer and the answer implied by the recording differ. */
export interface Divergence {
	site: string;
	state: Record<string, unknown>;
	/** What decide() answered, or "none" when no option fit. */
	live: DecideValue | "none";
	/** The answer that reproduces the recorded side effect. */
	demonstrated: DecideValue;
}

export interface ReplayReport {
	fixture: string;
	pass: boolean;
	result: RunResult;
	/** Recorded side-effecting calls the workflow did not make. */
	missing: CallRecord[];
	divergences: Divergence[];
	summary: string;
}

/** Share of a replay's judgments that may differ from the demonstration before the workflow is refused. */
export const MAX_DIVERGENCE = 0.25;
const MAX_RERUNS = 200;
const MAX_COMBINATIONS = 64;

interface JudgmentRef {
	key: string;
	question: DecideQuestion;
	/** The answer used in the run that stopped. */
	used: DecideValue | "none";
}

/** Where a run stopped for a reason a different judgment might cure. */
interface Stop {
	/** Tool calls answered before the stop. A cure must get further than this. */
	progress: number;
	/** Judgments made since the last reproduced side effect: the ones the failing call can depend on. */
	window: JudgmentRef[];
}

function optionsOf(question: DecideQuestion): DecideValue[] {
	if (question.type === "bool") return [true, false];
	if (question.type === "score") return (question.criteria as string[]).map((_, level) => level);
	return Object.keys(question.criteria as Record<string, string>);
}

export async function replayFixture(
	code: string,
	fixture: Fixture,
	tools: ToolDecl[],
	live: Pick<Host, "decide" | "ask">,
	options: { budget?: Partial<Budget>; signal?: AbortSignal } = {},
): Promise<ReplayReport> {
	const byKey = new Map<string, CallRecord[]>();
	const byTool = new Map<string, CallRecord[]>();
	for (const call of fixture.calls) {
		const key = `${call.tool}\n${canon(call.args)}`;
		byKey.set(key, [...(byKey.get(key) ?? []), call]);
		byTool.set(call.tool, [...(byTool.get(call.tool) ?? []), call]);
	}
	const recorded = new Map<string, unknown[]>();
	for (const d of fixture.decisions) {
		const key = `${d.kind}\n${d.id ?? ""}\n${canon(d.key)}`;
		recorded.set(key, [...(recorded.get(key) ?? []), d]);
	}

	// Live answers are asked once and reused across reruns. Forced answers override them.
	const liveAnswers = new Map<string, Promise<DecideValue | "none">>();
	const liveAsks = new Map<string, Promise<unknown>>();
	const forced = new Map<string, DecideValue>();

	const once = async (): Promise<{ result: RunResult; consumed: Set<number>; stop?: Stop }> => {
		const consumed = new Set<number>();
		const occurrences = new Map<string, number>();
		let window: JudgmentRef[] = [];
		let progress = 0;
		let stop: Stop | undefined;

		const host: Host = {
			async callTool(name, args) {
				const queue = byKey.get(`${name}\n${canon(args)}`);
				// A repeated identical read reuses the last recording. A repeated side effect does not:
				// issuing one more often than observed is a mismatch.
				const last = queue?.at(-1);
				const call = queue?.find((c) => !consumed.has(c.seq)) ?? (last?.readOnly ? last : undefined);
				if (!call) {
					stop ??= { progress, window: [...window] };
					const seen = (byTool.get(name) ?? []).slice(0, 6).map((c) => `  #${c.seq} ${preview(c.args, 160)}`);
					throw new StopError(
						`replay mismatch in ${fixture.id}: ${name}(${preview(args, 200)}) was never observed.\n` +
							(seen.length ? `Observed ${name} calls:\n${seen.join("\n")}` : `No ${name} call was observed in this recording.`),
					);
				}
				consumed.add(call.seq);
				progress++;
				if (!call.readOnly) window = [];
				if (!call.ok) throw new Error(call.error ?? "tool failed");
				return call.value;
			},
			async decide(question, signal) {
				const base = `${question.id}\n${canon(question.state)}`;
				const hit = recorded.get(`decide\n${base}`)?.[0] as { answer: DecideValue; by?: "s1" | "s2"; confidence?: number } | undefined;
				if (hit) return { answer: hit.answer, by: hit.by ?? "s2", confidence: hit.confidence ?? 1 };
				// The same question about the same state may be asked more than once in a run.
				const nth = occurrences.get(base) ?? 0;
				occurrences.set(base, nth + 1);
				const key = `${base}\n#${nth}`;
				let answer = liveAnswers.get(base);
				if (!answer) {
					answer = live.decide(question, signal).then(
						(a) => a.answer,
						(error) => {
							if (error instanceof EscalateError) return "none" as const;
							throw error;
						},
					);
					liveAnswers.set(base, answer);
				}
				const used = forced.get(key) ?? (await answer);
				const ref: JudgmentRef = { key, question, used };
				window.push(ref);
				if (used === "none") {
					stop ??= { progress, window: [ref] };
					throw new StopError(`decide("${question.id}"): none of the options fit, for state ${preview(question.state, 200)}`);
				}
				return { answer: used, by: "s2", confidence: 1 };
			},
			async ask(prompt, state, schema, signal) {
				const key = canon([prompt, state]);
				const hit = recorded.get(`ask\n\n${key}`)?.[0] as { answer: unknown } | undefined;
				if (hit) return hit.answer;
				let answer = liveAsks.get(key);
				if (!answer) {
					answer = live.ask(prompt, state, schema, signal);
					liveAsks.set(key, answer);
				}
				return answer;
			},
		};
		const result = await runWorkflow({ code, input: fixture.input, tools, host, budget: options.budget, signal: options.signal });
		return { result, consumed, stop };
	};

	let attempt = await once();
	let reruns = 0;
	// While the run stops where another judgment could help, look for the judgment that gets it further.
	search: while (attempt.stop?.window.length && reruns < MAX_RERUNS) {
		const { window, progress } = attempt.stop;
		// Vary the most recent judgment first: it is the likeliest to feed the failing call.
		const choices = [...window].reverse().map((ref) => ({ ref, options: [ref.used, ...optionsOf(ref.question).filter((o) => o !== ref.used)] }));
		const total = Math.min(MAX_COMBINATIONS, choices.reduce((n, c) => n * c.options.length, 1));
		for (let index = 1; index < total; index++) {
			const before = new Map(forced);
			let rest = index;
			let valid = true;
			for (const choice of choices) {
				const option = choice.options[rest % choice.options.length];
				rest = Math.floor(rest / choice.options.length);
				if (option === "none") valid = false;
				else forced.set(choice.ref.key, option);
			}
			if (!valid) {
				forced.clear();
				for (const [k, v] of before) forced.set(k, v);
				continue;
			}
			if (++reruns > MAX_RERUNS) break search;
			const next = await once();
			if (!next.stop || next.stop.progress > progress) {
				attempt = next;
				continue search;
			}
			forced.clear();
			for (const [k, v] of before) forced.set(k, v);
		}
		break;
	}

	const { result, consumed } = attempt;
	const divergences: Divergence[] = [];
	for (const [key, demonstrated] of forced) {
		const base = key.slice(0, key.lastIndexOf("\n#"));
		const liveAnswer = await liveAnswers.get(base);
		if (liveAnswer === undefined || liveAnswer === demonstrated) continue;
		const [site, state] = [base.slice(0, base.indexOf("\n")), JSON.parse(base.slice(base.indexOf("\n") + 1))];
		divergences.push({ site, state, live: liveAnswer, demonstrated });
	}

	const ignore = new Set(fixture.ignore);
	const missing = fixture.calls.filter((c) => !c.readOnly && c.ok && !consumed.has(c.seq) && !ignore.has(c.seq));
	const judgments = result.decisions.filter((d) => d.kind === "decide").length;
	const tooMany = divergences.length > 0 && divergences.length / Math.max(1, judgments) > MAX_DIVERGENCE;
	const pass = result.status === "ok" && missing.length === 0 && !tooMany;

	const differing = divergences
		.slice(0, 8)
		.map((d) => `  ${d.site}: decide() said ${JSON.stringify(d.live)}, the recorded run implies ${JSON.stringify(d.demonstrated)}, for ${preview(d.state, 220)}`);
	const lines: string[] = [];
	if (result.status !== "ok") lines.push(`${result.status}: ${result.reason ?? "unknown"}`);
	if (missing.length) {
		lines.push(
			`${missing.length} recorded side effect(s) were not reproduced:`,
			...missing.slice(0, 12).map((c) => `  #${c.seq} ${c.tool}(${preview(c.args, 200)})`),
		);
	}
	if (tooMany) {
		lines.push(
			`${divergences.length} of ${judgments} judgments differ from the recorded run, more than ${MAX_DIVERGENCE * 100}%. The questions do not reproduce the demonstrated decisions; sharpen the instructions and criteria:`,
			...differing,
		);
	}
	const summary = pass
		? `${fixture.id}: PASS (${result.calls.length} calls, ${result.decisions.length} judgments)` +
			(divergences.length
				? `\n  ${divergences.length} judgment(s) differ from the recorded run. The program is admitted; check which side is right:\n${differing.map((l) => `  ${l}`).join("\n")}`
				: "")
		: `${fixture.id}: FAIL\n${lines.join("\n")}`;
	return { fixture: fixture.id, pass, result, missing, divergences, summary };
}
