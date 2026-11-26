/**
 * Workflow Memory on disk: one directory per workflow.
 *
 *   <root>/<name>/workflow.js        the program (written by the model, through the gate)
 *   <root>/<name>/meta.json          runtime-owned metadata
 *   <root>/<name>/fixtures/<id>.json recorded executions every version must reproduce
 *   <root>/<name>/versions/v<N>.js   earlier versions
 *   <root>/<name>/runs/<stamp>.json  journals of failed and escalated runs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canon, type Fixture, type RunResult, type Trace, type WorkflowMeta } from "./types.ts";

export const NAME_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_RUN_FIXTURES = 5;
const MAX_RUN_JOURNALS = 20;

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export interface LoadedWorkflow {
	meta: WorkflowMeta;
	code: string;
	/** False when workflow.js no longer matches the hash recorded at admission. */
	intact: boolean;
}

export class WorkflowStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	private dir(name: string): string {
		if (!NAME_PATTERN.test(name)) throw new Error(`invalid workflow name "${name}": use lowercase letters, digits and _`);
		return join(this.root, name);
	}

	list(): WorkflowMeta[] {
		if (!existsSync(this.root)) return [];
		const metas: WorkflowMeta[] = [];
		for (const entry of readdirSync(this.root, { withFileTypes: true })) {
			if (!entry.isDirectory() || !NAME_PATTERN.test(entry.name)) continue;
			const meta = readJson<WorkflowMeta>(join(this.root, entry.name, "meta.json"));
			if (meta) metas.push(meta);
		}
		return metas.sort((a, b) => a.name.localeCompare(b.name));
	}

	load(name: string): LoadedWorkflow | undefined {
		const dir = this.dir(name);
		const meta = readJson<WorkflowMeta>(join(dir, "meta.json"));
		if (!meta || !existsSync(join(dir, "workflow.js"))) return undefined;
		const code = readFileSync(join(dir, "workflow.js"), "utf8");
		return { meta, code, intact: sha256(code) === meta.sha256 };
	}

	/** Write an admitted version. The caller has already run the gate. */
	save(meta: WorkflowMeta, code: string, fixtures: Fixture[]): void {
		const dir = this.dir(meta.name);
		mkdirSync(join(dir, "fixtures"), { recursive: true });
		const previous = this.load(meta.name);
		if (previous && previous.code !== code) {
			mkdirSync(join(dir, "versions"), { recursive: true });
			writeFileSync(join(dir, "versions", `v${previous.meta.version}.js`), previous.code);
		}
		writeFileSync(join(dir, "workflow.js"), code);
		const keep = new Set(fixtures.map((f) => `${f.id}.json`));
		for (const file of readdirSync(join(dir, "fixtures"))) {
			if (!keep.has(file)) rmSync(join(dir, "fixtures", file));
		}
		for (const fixture of fixtures) writeJson(join(dir, "fixtures", `${fixture.id}.json`), fixture);
		writeJson(join(dir, "meta.json"), meta);
	}

	updateMeta(name: string, change: (meta: WorkflowMeta) => void): WorkflowMeta | undefined {
		const path = join(this.dir(name), "meta.json");
		const meta = readJson<WorkflowMeta>(path);
		if (!meta) return undefined;
		change(meta);
		meta.updatedAt = new Date().toISOString();
		writeJson(path, meta);
		return meta;
	}

	fixtures(name: string): Fixture[] {
		const dir = join(this.dir(name), "fixtures");
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.flatMap((file) => readJson<Fixture>(join(dir, file)) ?? []);
	}

	/** A successful run becomes a regression fixture; only the most recent few are kept. */
	addRunFixture(name: string, input: unknown, result: RunResult): void {
		const dir = join(this.dir(name), "fixtures");
		mkdirSync(dir, { recursive: true });
		const fixture: Fixture = {
			id: `run-${stamp()}`,
			source: "run",
			input,
			ignore: [],
			calls: result.calls,
			decisions: result.decisions,
		};
		writeJson(join(dir, `${fixture.id}.json`), fixture);
		const runs = readdirSync(dir).filter((file) => file.startsWith("run-")).sort();
		for (const file of runs.slice(0, Math.max(0, runs.length - MAX_RUN_FIXTURES))) rmSync(join(dir, file));
	}

	/** Keep the journal of a run that did not succeed, so it can be inspected and learned from. */
	writeRunJournal(name: string, input: unknown, result: RunResult): string {
		const dir = join(this.dir(name), "runs");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${stamp()}-${result.status}.json`);
		writeJson(path, { input, ...result });
		const files = readdirSync(dir).sort();
		for (const file of files.slice(0, Math.max(0, files.length - MAX_RUN_JOURNALS))) rmSync(join(dir, file));
		return path;
	}

	/**
	 * Keep what a workflow_save call submitted and how the gate judged it, admitted or not, so a
	 * refusal can be studied and replayed later. Only the most recent attempts are kept.
	 */
	writeAttempt(attempt: Record<string, unknown>): string {
		const dir = join(this.root, "_attempts");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${stamp()}.json`);
		writeJson(path, attempt);
		const files = readdirSync(dir).sort();
		for (const file of files.slice(0, Math.max(0, files.length - MAX_RUN_JOURNALS))) rmSync(join(dir, file));
		return path;
	}

	remove(name: string): void {
		rmSync(this.dir(name), { recursive: true, force: true });
	}
}

/** Recorded agent runs, the raw material for compilation. */
export class TraceStore {
	readonly root: string;
	private readonly max: number;

	constructor(root: string, max = 50) {
		this.root = root;
		this.max = max;
	}

	write(trace: Trace): void {
		mkdirSync(this.root, { recursive: true });
		writeJson(join(this.root, `${trace.id}.json`), trace);
		const files = readdirSync(this.root).filter((file) => file.endsWith(".json")).sort();
		for (const file of files.slice(0, Math.max(0, files.length - this.max))) rmSync(join(this.root, file));
	}

	load(id: string): Trace | undefined {
		if (!/^[\w-]+$/.test(id)) return undefined;
		return readJson<Trace>(join(this.root, `${id}.json`));
	}

	/** Most recent first. */
	list(): Trace[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.reverse()
			.flatMap((file) => readJson<Trace>(join(this.root, file)) ?? []);
	}
}

export function traceToFixture(trace: Trace, input: unknown, ignore: number[]): Fixture {
	return { id: trace.id, source: "trace", prompt: trace.prompt, input, ignore, calls: trace.calls, decisions: [] };
}

/** Hash of the parameter schemas of the given tools, to notice when a tool changes under a workflow. */
export function hashTools(tools: { name: string; parameters?: unknown }[]): string {
	return sha256(canon([...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.name, t.parameters ?? null])));
}

/** Sortable and unique enough for file names: 20261126T101502-4821. */
export function stamp(): string {
	const iso = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
	return `${iso}-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
}

/** Character-bigram Jaccard similarity; works for space-free scripts such as Japanese too. */
export function similarity(a: string, b: string): number {
	const grams = (text: string) => {
		const s = text.toLowerCase().replace(/\s+/g, " ").trim();
		const set = new Set<string>();
		for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
		return set;
	};
	const x = grams(a);
	const y = grams(b);
	if (!x.size || !y.size) return 0;
	let shared = 0;
	for (const g of x) if (y.has(g)) shared++;
	return shared / (x.size + y.size - shared);
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
}
