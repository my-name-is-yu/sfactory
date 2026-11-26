/**
 * The decision cascade behind `decide()`.
 *
 * Every decision site starts on the LLM (tier s2). While it does, the decision model answers the
 * same question in the shadow and the two are compared. Once enough samples show that the decision
 * model agrees with the LLM above some confidence, the site moves to tier s1: confident answers come
 * from the decision model alone, the rest still go to the LLM. Sites move back when agreement drops.
 */
import { type DecideAnswer, type DecideQuestion, type DecideValue, EscalateError, type SiteState } from "./types.ts";

export interface CascadeConfig {
	/** "llm": never use the decision model. "auto": shadow, then promote per site. */
	mode: "llm" | "auto";
	/** Samples needed before a site may be promoted. */
	minSamples: number;
	/** Required agreement with the LLM among answers at or above the threshold. */
	minAgreement: number;
	/** Share of samples the threshold must keep, so a site is not promoted on a few lucky answers. */
	minCoverage: number;
	/** In tier s1, every n-th decision model answer is also checked by the LLM. */
	auditEvery: number;
	/** Samples kept per site. */
	window: number;
}

export const DEFAULT_CASCADE: CascadeConfig = {
	mode: "auto",
	minSamples: 20,
	minAgreement: 0.95,
	minCoverage: 0.3,
	auditEvery: 10,
	window: 100,
};

/** What happened at one decide() call, for measurement. */
export interface DecideEvent {
	site: string;
	/**
	 * llm_only: no decision model in play. shadow: the LLM answered, the decision model was compared.
	 * s1: the decision model answered alone. s1_audit: it answered and the LLM checked it.
	 * s1_fallback: its confidence was below the threshold, so the LLM answered.
	 */
	path: "llm_only" | "shadow" | "s1" | "s1_audit" | "s1_fallback";
	by: "s1" | "s2";
	/** Decision model confidence, when it answered. */
	confidence?: number;
	/** Whether the two tiers agreed, when both answered. */
	agreed?: boolean;
	tierBefore: "s1" | "s2";
	tierAfter: "s1" | "s2";
	tau: number;
	samples: number;
}

export interface CascadeDeps {
	config: CascadeConfig;
	onEvent?: (event: DecideEvent) => void;
	sites: Record<string, SiteState>;
	/** Decision model. Resolves to undefined when none is available or the call failed. */
	classify?: (question: DecideQuestion, signal: AbortSignal) => Promise<{ answer: DecideValue; confidence: number } | undefined>;
	/** LLM answer, or "none" when no option fits. */
	llm: (question: DecideQuestion, signal: AbortSignal) => Promise<DecideValue | "none">;
}

export async function decideCascade(question: DecideQuestion, deps: CascadeDeps, signal: AbortSignal): Promise<DecideAnswer> {
	const { config } = deps;
	const askLlm = async (): Promise<DecideValue> => {
		const answer = await deps.llm(question, signal);
		if (answer === "none") {
			throw new EscalateError(`decide("${question.id}"): none of the options fit`, {
				question: question.instructions,
				state: question.state,
			});
		}
		return answer;
	};

	if (config.mode === "llm" || !deps.classify) {
		const answer = await askLlm();
		deps.onEvent?.({ site: question.id, path: "llm_only", by: "s2", tierBefore: "s2", tierAfter: "s2", tau: 1, samples: 0 });
		return { answer, by: "s2", confidence: 1 };
	}

	const site = (deps.sites[question.id] ??= { tier: "s2", tau: 1, samples: [], served: 0 });
	const tierBefore = site.tier;
	const emit = (path: DecideEvent["path"], by: "s1" | "s2", confidence?: number, agreed?: boolean) =>
		deps.onEvent?.({ site: question.id, path, by, confidence, agreed, tierBefore, tierAfter: site.tier, tau: site.tau, samples: site.samples.length });
	const record = (confidence: number, agreed: boolean) => {
		site.samples.push([round(confidence), agreed ? 1 : 0]);
		if (site.samples.length > config.window) site.samples.splice(0, site.samples.length - config.window);
		const tau = calibrate(site.samples, config);
		if (tau === undefined) site.tier = "s2";
		else {
			site.tier = "s1";
			site.tau = tau;
		}
	};
	const classify = () => deps.classify!(question, signal).catch(() => undefined);

	if (site.tier === "s1") {
		const fast = await classify();
		if (fast && fast.confidence >= site.tau) {
			site.served++;
			if (site.served % config.auditEvery !== 0) {
				emit("s1", "s1", fast.confidence);
				return { answer: fast.answer, by: "s1", confidence: fast.confidence };
			}
			const slow = await askLlm();
			const agreed = same(fast.answer, slow);
			record(fast.confidence, agreed);
			emit("s1_audit", agreed ? "s1" : "s2", fast.confidence, agreed);
			return agreed ? { answer: fast.answer, by: "s1", confidence: fast.confidence } : { answer: slow, by: "s2", confidence: 1 };
		}
		const slow = await askLlm();
		if (fast) record(fast.confidence, same(fast.answer, slow));
		emit("s1_fallback", "s2", fast?.confidence, fast ? same(fast.answer, slow) : undefined);
		return { answer: slow, by: "s2", confidence: 1 };
	}

	const [slow, fast] = await Promise.all([askLlm(), classify()]);
	if (fast) record(fast.confidence, same(fast.answer, slow));
	emit(fast ? "shadow" : "llm_only", "s2", fast?.confidence, fast ? same(fast.answer, slow) : undefined);
	return { answer: slow, by: "s2", confidence: 1 };
}

/**
 * The smallest confidence threshold at which the decision model agreed with the LLM often enough,
 * or undefined when there is none yet.
 */
export function calibrate(samples: [number, 0 | 1][], config: CascadeConfig): number | undefined {
	if (samples.length < config.minSamples) return undefined;
	const sorted = [...samples].sort((a, b) => b[0] - a[0]);
	const minKept = Math.max(5, Math.ceil(samples.length * config.minCoverage));
	let agreed = 0;
	let best: number | undefined;
	for (let i = 0; i < sorted.length; i++) {
		agreed += sorted[i][1];
		// Only cut between distinct confidences: a threshold keeps every sample at that value.
		if (i + 1 < sorted.length && sorted[i + 1][0] === sorted[i][0]) continue;
		const kept = i + 1;
		if (kept >= minKept && agreed / kept >= config.minAgreement) best = sorted[i][0];
	}
	return best;
}

function same(a: DecideValue, b: DecideValue): boolean {
	return a === b;
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

// --- LLM side of decide() and ask(): prompts and parsing ---

export const DECIDE_SYSTEM =
	"You make one bounded judgment about the given state. Reply with a single JSON object and nothing else.";

export function buildDecidePrompt(q: DecideQuestion): string {
	const lines = [q.instructions, ""];
	if (q.type === "choice") {
		lines.push("Options:");
		for (const [label, meaning] of Object.entries(q.criteria as Record<string, string>)) lines.push(`- ${JSON.stringify(label)}: ${meaning}`);
		lines.push("", 'Reply {"answer": "<one option label>"}, or {"answer": null} if none of the options fits.');
	} else if (q.type === "bool") {
		const c = q.criteria as Record<string, string>;
		lines.push(`- true: ${c.true}`, `- false: ${c.false}`);
		lines.push("", 'Reply {"answer": true} or {"answer": false}, or {"answer": null} if it cannot be judged from the state.');
	} else {
		lines.push("Levels:");
		(q.criteria as string[]).forEach((level, i) => lines.push(`- ${i}: ${level}`));
		lines.push("", 'Reply {"answer": <level number>}, or {"answer": null} if it cannot be judged from the state.');
	}
	lines.push("", "State:", JSON.stringify(q.state, null, 1));
	return lines.join("\n");
}

export function parseDecide(q: DecideQuestion, text: string): DecideValue | "none" {
	const answer = (extractJson(text) as { answer?: unknown } | undefined)?.answer;
	if (answer === null) return "none";
	if (q.type === "choice") {
		if (typeof answer === "string" && Object.hasOwn(q.criteria as object, answer)) return answer;
	} else if (q.type === "bool") {
		if (typeof answer === "boolean") return answer;
	} else if (typeof answer === "number" && Number.isInteger(answer) && answer >= 0 && answer < (q.criteria as string[]).length) {
		return answer;
	}
	throw new Error(`decide("${q.id}"): the model's reply is not a valid answer: ${text.slice(0, 200)}`);
}

export const ASK_SYSTEM =
	"You produce one structured value for a program. Reply with a single JSON value that matches the schema and nothing else.";

export function buildAskPrompt(prompt: string, state: unknown, schema: unknown): string {
	const lines = [prompt];
	if (state !== null && state !== undefined) lines.push("", "State:", JSON.stringify(state, null, 1));
	if (schema) lines.push("", "Reply with JSON matching this JSON Schema:", JSON.stringify(schema));
	else lines.push("", 'Reply with JSON of the form {"text": "..."}');
	return lines.join("\n");
}

/** Parse the reply and check the top-level shape. Deep validation is left to the workflow. */
export function parseAsk(text: string, schema: unknown): unknown {
	const value = extractJson(text);
	if (value === undefined) throw new Error(`ask(): the model's reply is not JSON: ${text.slice(0, 200)}`);
	const s = schema as { type?: string; required?: string[] } | null;
	if (s?.type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ask(): expected a JSON object");
		for (const key of s.required ?? []) {
			if (!Object.hasOwn(value as object, key)) throw new Error(`ask(): the reply lacks required property "${key}"`);
		}
	} else if (s?.type === "array" && !Array.isArray(value)) {
		throw new Error("ask(): expected a JSON array");
	}
	return value;
}

/** The JSON value in a model reply, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
	const trimmed = text.trim();
	const candidates = [trimmed];
	const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	if (fence) candidates.push(fence[1].trim());
	for (const [open, close] of [
		["{", "}"],
		["[", "]"],
	]) {
		const start = trimmed.indexOf(open);
		const end = trimmed.lastIndexOf(close);
		if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
	}
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// try the next form
		}
	}
	return undefined;
}
