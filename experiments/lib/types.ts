/** What a task has to provide so the runner can run and score it. */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export type Split = "train" | "calib" | "test" | "adapt";

export interface Episode {
	/** Unique and stable, e.g. tickets/test-2. */
	id: string;
	task: string;
	split: Split;
	/** standard, paraphrase, param, extra, distractor, volume, partial, drift, unknown. */
	kind: string;
	/** The whole request the agent receives. Nothing else describes the task to it. */
	prompt: string;
	/**
	 * Whether a workflow learned on the standard task fits this episode:
	 * expected = it applies as is; possible = only with changes or extra steps; wrong = a different task.
	 */
	reuse: "expected" | "possible" | "wrong";
}

export interface Verdict {
	/** Every item reached its required final state and nothing else was changed. */
	success: boolean;
	/** Items in their required final state. */
	correct: number;
	/** Items the task required to change. */
	items: number;
	/** Items left exactly as they were. */
	missed: number;
	sideEffects: {
		/** Successful writes. */
		writes: number;
		/** Successful writes that changed nothing: repeated or unnecessary. */
		noop: number;
		/** Successful writes to something the task did not allow to change. */
		forbidden: number;
		/** Things that ended up changed although they had to stay as they were. */
		collateral: number;
		/** Write attempts the environment refused. */
		refused: number;
		/** Attempts on an item after the environment had already said it cannot be changed. */
		retriesAfterRefusal: number;
	};
	/** Per item: what was wrong. For reading a failure, not for scoring. */
	errors: string[];
	/** Extra task-specific observations, e.g. whether refused items were reported. */
	notes: Record<string, unknown>;
}

/** One fresh world for one trial. */
export interface Instance {
	/** Registers the task's tools, backed by this world. */
	extension: ExtensionFactory;
	/** Deterministic: reads only the world's final state and its write log. */
	verify(finalAnswer: string): Verdict;
}

export interface Task {
	name: string;
	episodes(): Episode[];
	instantiate(episode: Episode): Instance;
}

/** Deterministic pseudo-random numbers from a string seed (mulberry32 over an FNV hash). */
export function rng(seed: string): () => number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	let a = h >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function shuffled<T>(items: readonly T[], seed: string): T[] {
	const out = [...items];
	const next = rng(seed);
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}
