/** Shared data model. Everything here is plain JSON so it can be written to disk as is. */

/** One leaf tool call, as observed in a cold run or issued by a workflow run. */
export interface CallRecord {
	/** Position in the run, starting at 1. Stable id used by `ignore` lists. */
	seq: number;
	tool: string;
	args: unknown;
	ok: boolean;
	/** What a script receives for the call: structured content when the tool has it, else its text. */
	value?: unknown;
	error?: string;
	/** The tool is known not to change its environment. Calls without it count as side effects. */
	readOnly: boolean;
	ms?: number;
}

export type DecideType = "choice" | "bool" | "score";

/** A bounded semantic judgment: the only kind of question a decision model answers. */
export interface DecideQuestion {
	/** Stable id of the decision site in the workflow source. Calibration is kept per id. */
	id: string;
	state: Record<string, unknown>;
	type: DecideType;
	instructions: string;
	/** choice: label -> meaning. bool: { true, false }. score: level descriptions, lowest first. */
	criteria: Record<string, string> | string[];
}

export type DecideValue = string | boolean | number;

export interface DecideAnswer {
	answer: DecideValue;
	/** Which tier answered: the decision model (s1) or the LLM (s2). */
	by: "s1" | "s2";
	confidence: number;
}

export interface DecisionRecord {
	seq: number;
	kind: "decide" | "ask";
	id?: string;
	/** decide: the state. ask: [prompt, state]. Used to match recorded answers on replay. */
	key: unknown;
	answer: unknown;
	by?: "s1" | "s2";
	confidence?: number;
}

/** A recorded execution a workflow version must reproduce before it is admitted. */
export interface Fixture {
	id: string;
	source: "trace" | "run";
	prompt?: string;
	input: unknown;
	/** `seq` of recorded side-effecting calls the workflow need not reproduce (exploration). */
	ignore: number[];
	calls: CallRecord[];
	decisions: DecisionRecord[];
}

export type RunStatus = "ok" | "escalated" | "failed";

export interface RunResult {
	status: RunStatus;
	value?: unknown;
	/** Text the script printed with text() and console. */
	output: string;
	/** Why the run escalated or failed. */
	reason?: string;
	/** State the script handed over with escalate(). */
	state?: unknown;
	calls: CallRecord[];
	decisions: DecisionRecord[];
	ms: number;
}

/** Per decision site: which tier answers it, and the evidence for that. */
export interface SiteState {
	tier: "s2" | "s1";
	/** Confidence at or above which the decision model's answer is used. */
	tau: number;
	/** [decision model confidence, agreed with the LLM] for recent decisions answered by both. */
	samples: [number, 0 | 1][];
	/** Decisions the decision model answered alone, for audit sampling. */
	served: number;
}

export type WorkflowStatus = "candidate" | "probation" | "trusted" | "retired";

/** Runtime-owned metadata. The model writes the code; it never writes this file. */
export interface WorkflowMeta {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** The only tools injected into the sandbox: those observed in the fixtures. */
	tools: string[];
	/** Hash of those tools' parameter schemas at admission. A change marks the workflow stale. */
	toolsHash: string;
	/** Hash of workflow.js at admission. A mismatch means it was edited outside workflow_save. */
	sha256: string;
	version: number;
	status: WorkflowStatus;
	createdAt: string;
	updatedAt: string;
	stats: {
		runs: number;
		ok: number;
		failed: number;
		escalated: number;
		consecutiveOk: number;
		lastUsed?: string;
		lastError?: string;
	};
	sites: Record<string, SiteState>;
	notes: string[];
}

/** One agent run recorded for later compilation. */
export interface Trace {
	id: string;
	prompt: string;
	startedAt: string;
	turns: number;
	tokens: { input: number; output: number; cost: number };
	/** Set when the run used a saved workflow; such runs are not compilation sources. */
	usedWorkflow?: string;
	calls: CallRecord[];
}

/** Thrown by a host to end the run and hand control back to the main model. */
export class EscalateError extends Error {
	state: unknown;
	constructor(reason: string, state?: unknown) {
		super(reason);
		this.name = "EscalateError";
		this.state = state;
	}
}

/** Thrown by a host to end the run as failed, in a way the script cannot catch. */
export class StopError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "StopError";
	}
}

/** JSON with sorted keys, so equal values always produce equal text. */
export function canon(value: unknown): string {
	return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as object).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v !== undefined) out[key] = sortKeys(v);
		}
		return out;
	}
	return value;
}

export function preview(value: unknown, max = 300): string {
	const text = typeof value === "string" ? value : canon(value);
	return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}
