/**
 * Runs trials. One trial is one fresh Pi session and one fresh world; the only thing that can carry
 * over between trials of an arm is that arm's Workflow Memory directory.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createSfactory } from "../../extensions/sfactory/index.ts";
import { WorkflowStore } from "../../extensions/sfactory/src/store.ts";
import type { SiteState } from "../../extensions/sfactory/src/types.ts";
import { createCollector, type TrialMetrics } from "./metrics.ts";
import type { Episode, Split, Task, Verdict } from "./types.ts";

export interface Arm {
	id: string;
	label: string;
	codemode: boolean;
	/** Scripts and workflows may call the decision model. */
	decisionModel: boolean;
	/** Workflow Memory is loaded and persists across the arm's trials. */
	memory: boolean;
}

export const ARMS: Record<string, Arm> = {
	A: { id: "A", label: "Pi", codemode: false, decisionModel: false, memory: false },
	B: { id: "B", label: "Pi + Code Mode", codemode: true, decisionModel: false, memory: false },
	C: { id: "C", label: "Pi + Code Mode + Decision Model", codemode: true, decisionModel: true, memory: false },
	D: { id: "D", label: "Pi + Code Mode + Workflow Memory", codemode: true, decisionModel: false, memory: true },
	E: { id: "E", label: "SFactory (all)", codemode: true, decisionModel: true, memory: true },
};

export interface Phase {
	name: string;
	split: Split;
	/**
	 * true: the arm's memory learns from the trial and the next trial sees the result.
	 * false: every trial starts from a copy of the memory as it stood when the phase began, with
	 * saving, recording and calibration switched off, and the copy is thrown away afterwards.
	 */
	learn: boolean;
}

export const PHASES: Record<string, Phase> = {
	train: { name: "train", split: "train", learn: true },
	calib: { name: "calib", split: "calib", learn: true },
	test: { name: "test", split: "test", learn: false },
	adapt: { name: "adapt", split: "adapt", learn: false },
	"test-online": { name: "test-online", split: "test", learn: true },
	"adapt-online": { name: "adapt-online", split: "adapt", learn: true },
};

export interface RunOptions {
	task: Task;
	arms: Arm[];
	phases: Phase[];
	/** A Pi model object, e.g. from ModelRuntime.getModel(). */
	model: any;
	modelRuntime?: ModelRuntime;
	/** Decision model as provider/id, for arms that use one. */
	classifier?: string;
	thinking?: string;
	outDir: string;
	/** Pi's config directory, for credentials. Default: Pi's own default. */
	agentDir?: string;
	/** Extra extensions for every trial, e.g. a provider registration. */
	extensions?: ExtensionFactory[];
	timeoutMs?: number;
	/** Run only the first n episodes of each phase. */
	limit?: number;
	/** Run only episodes whose id ends with one of these, e.g. "train-2". */
	episodes?: string[];
	minSamples?: number;
	repeat?: number;
	log?: (line: string) => void;
}

export interface SiteSnapshot {
	workflow: string;
	site: string;
	tier: string;
	tau: number;
	samples: number;
	agreement: number | null;
	served: number;
}

export interface TrialRecord {
	seq: number;
	arm: string;
	repeat: number;
	phase: string;
	learn: boolean;
	episode: string;
	split: Split;
	kind: string;
	reuse: Episode["reuse"];
	model: string;
	classifier: string | null;
	thinking: string;
	startedAt: string;
	wallMs: number;
	/** completed, timeout, or error. A trial that did not complete counts as a failure. */
	outcome: "completed" | "timeout" | "error";
	error?: string;
	verdict: Verdict;
	metrics: TrialMetrics;
	/** Workflows in memory when the trial started and when it ended. */
	memoryBefore: { name: string; version: number; status: string }[];
	memoryAfter: { name: string; version: number; status: string }[];
	sites: SiteSnapshot[];
	/** A saved workflow ran. */
	reused: boolean;
	/** A saved workflow ran on a task it was not learned for. */
	misapplied: boolean;
	/** A fitting workflow existed and was not used. */
	missedReuse: boolean;
}

const SKILLS = resolve(import.meta.dirname, "..", "..", "skills");
/** Pi's own documentation. The codemode tool tells the model to read its reference there before using `models`. */
const PI_DOCS = resolve(import.meta.dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "docs");
const EXCLUDED = ["bash", "powershell", "edit", "write", "grep", "find", "ls", "tool_search"];

/**
 * The agent may read files only inside its trial directory, plus the documentation its tools refer
 * it to, and gets no shell or file-writing tools. Gold data and the experiment's source are
 * therefore out of reach.
 */
function jail(cwd: string, readable: string[]): ExtensionFactory {
	const roots = [cwd, ...readable].map((root) => (existsSync(root) ? realpathSync(root) : root));
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", async (event, ctx) => {
			if (EXCLUDED.includes(event.toolName)) return { block: true, reason: `${event.toolName} is not available in this experiment` };
			if (event.toolName !== "read") return;
			const raw = String((event.input as { path?: unknown }).path ?? "").replace(/^@/, "");
			let target = resolve(ctx.cwd, raw);
			if (existsSync(target)) target = realpathSync(target);
			const inside = roots.some((root) => {
				const rel = relative(root, target);
				return !rel.startsWith("..") && !isAbsolute(rel);
			});
			if (!inside) return { block: true, reason: "read is limited to files inside the trial directory; this path is outside the trial directory" };
		});
	};
}

function inventory(cwd: string) {
	return new WorkflowStore(join(cwd, ".pi", "workflows"))
		.list()
		.filter((meta) => meta.status !== "retired")
		.map((meta) => ({ name: meta.name, version: meta.version, status: meta.status }));
}

function siteSnapshots(cwd: string): SiteSnapshot[] {
	return new WorkflowStore(join(cwd, ".pi", "workflows")).list().flatMap((meta) =>
		Object.entries(meta.sites as Record<string, SiteState>).map(([site, state]) => ({
			workflow: meta.name,
			site,
			tier: state.tier,
			tau: state.tau,
			samples: state.samples.length,
			agreement: state.samples.length ? state.samples.filter(([, agreed]) => agreed).length / state.samples.length : null,
			served: state.served,
		})),
	);
}

const EMPTY_VERDICT: Verdict = {
	success: false,
	correct: 0,
	items: 0,
	missed: 0,
	sideEffects: { writes: 0, noop: 0, forbidden: 0, collateral: 0, refused: 0, retriesAfterRefusal: 0 },
	errors: [],
	notes: {},
};

export async function runTrial(
	options: RunOptions,
	arm: Arm,
	phase: Phase,
	episode: Episode,
	/** The arm's persistent memory directory. Unused by arms without memory. */
	memoryDir: string,
	seq: number,
): Promise<{ record: TrialRecord; transcript: Record<string, unknown>[] }> {
	// The session's working directory. Arms without memory, and frozen trials, get a throwaway one.
	const persistent = arm.memory && phase.learn;
	let cwd = memoryDir;
	if (!persistent) {
		cwd = mkdtempSync(join(tmpdir(), "sfactory-trial-"));
		if (arm.memory && existsSync(join(memoryDir, ".pi"))) cpSync(join(memoryDir, ".pi"), join(cwd, ".pi"), { recursive: true });
	}
	mkdirSync(cwd, { recursive: true });

	const instance = options.task.instantiate(episode);
	const collector = createCollector();
	const useSkill = arm.memory && phase.learn;
	const memoryBefore = arm.memory ? inventory(cwd) : [];
	const classifier = arm.decisionModel ? (options.classifier ?? null) : null;

	const factories: ExtensionFactory[] = [...(options.extensions ?? []), jail(cwd, [...(useSkill ? [SKILLS] : []), ...(arm.codemode ? [PI_DOCS] : [])])];
	if (arm.codemode) factories.push(createCodemodeExtension({ mode: "on", models: arm.decisionModel }));
	if (arm.memory) {
		factories.push(
			createSfactory({
				decide: arm.decisionModel ? "auto" : "llm",
				classifier: classifier ?? undefined,
				learn: phase.learn,
				minSamples: options.minSamples,
			}),
		);
	}
	factories.push(instance.extension, collector.extension);

	// The resource loader needs the config directory spelled out; Pi's own default holds the credentials.
	const agentDir = options.agentDir ?? getAgentDir();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		...(agentDir ? { agentDir } : {}),
		extensionFactories: factories,
		additionalSkillPaths: useSkill ? [SKILLS] : [],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	} as never);
	await resourceLoader.reload();
	const settingsManager = SettingsManager.inMemory((arm.codemode ? { defaultTools: ["+codemode"] } : {}) as never);

	const started = Date.now();
	const record: TrialRecord = {
		seq,
		arm: arm.id,
		repeat: options.repeat ?? 0,
		phase: phase.name,
		learn: phase.learn,
		episode: episode.id,
		split: episode.split,
		kind: episode.kind,
		reuse: episode.reuse,
		model: `${options.model.provider}/${options.model.id}`,
		classifier,
		thinking: options.thinking ?? "low",
		startedAt: new Date(started).toISOString(),
		wallMs: 0,
		outcome: "completed",
		verdict: EMPTY_VERDICT,
		metrics: collector.metrics,
		memoryBefore,
		memoryAfter: [],
		sites: [],
		reused: false,
		misapplied: false,
		missedReuse: false,
	};

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let timer: NodeJS.Timeout | undefined;
	try {
		({ session } = await createAgentSession({
			cwd,
			...(agentDir ? { agentDir } : {}),
			model: options.model,
			modelRuntime: options.modelRuntime,
			thinkingLevel: (options.thinking ?? "low") as never,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			excludeTools: EXCLUDED,
		}));
		await session.bindExtensions({});
		const timeoutMs = options.timeoutMs ?? 900_000;
		const timedOut = new Promise<"timeout">((done) => {
			timer = setTimeout(() => done("timeout"), timeoutMs);
		});
		const finished = await Promise.race([session.prompt(episode.prompt).then(() => "done" as const), timedOut]);
		if (finished === "timeout") {
			record.outcome = "timeout";
			await session.abort().catch(() => undefined);
		}
		const last = session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
		if (last?.role === "assistant" && last.stopReason === "error") {
			record.outcome = "error";
			record.error = last.errorMessage ?? "the model request failed";
		}
	} catch (error) {
		record.outcome = "error";
		record.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
	} finally {
		clearTimeout(timer);
		session?.dispose();
	}

	record.wallMs = Date.now() - started;
	record.metrics = collector.finish();
	// The world is scored as it stands, whatever happened to the session.
	record.verdict = instance.verify(record.metrics.finalAnswer);
	if (record.outcome !== "completed") record.verdict = { ...record.verdict, success: false };
	record.memoryAfter = arm.memory ? inventory(cwd) : [];
	record.sites = arm.memory ? siteSnapshots(cwd) : [];
	const ran = record.metrics.workflow.runs.filter((run) => run.status !== "refused");
	record.reused = ran.length > 0;
	record.misapplied = record.reused && episode.reuse === "wrong";
	record.missedReuse = arm.memory && memoryBefore.length > 0 && episode.reuse === "expected" && !record.reused;

	if (!persistent) rmSync(cwd, { recursive: true, force: true });
	return { record, transcript: collector.transcript };
}

/** Run every arm through every phase. Finished trials are kept, so an interrupted run resumes. */
export async function runSuite(options: RunOptions): Promise<TrialRecord[]> {
	const log = options.log ?? (() => undefined);
	const repeat = options.repeat ?? 0;
	const episodes = options.task.episodes();
	const records: TrialRecord[] = [];
	mkdirSync(options.outDir, { recursive: true });

	for (const arm of options.arms) {
		const armDir = join(options.outDir, `rep${repeat}`, arm.id);
		const memoryDir = join(armDir, "memory");
		mkdirSync(join(armDir, "trials"), { recursive: true });
		mkdirSync(memoryDir, { recursive: true });
		let seq = 0;
		for (const phase of options.phases) {
			const list = episodes
				.filter((episode) => episode.split === phase.split)
				.filter((episode) => !options.episodes || options.episodes.some((suffix) => episode.id.endsWith(suffix)))
				.slice(0, options.limit ?? Number.POSITIVE_INFINITY);
			// A frozen phase reads one snapshot, so later trials cannot see anything earlier ones did.
			for (const episode of list) {
				seq++;
				const file = join(armDir, "trials", `${String(seq).padStart(3, "0")}-${phase.name}-${episode.id.replace(/\W+/g, "_")}.json`);
				if (existsSync(file)) {
					records.push(JSON.parse(readFileSync(file, "utf8")) as TrialRecord);
					log(`${arm.id} ${phase.name} ${episode.id}: already done`);
					continue;
				}
				const { record, transcript } = await runTrial(options, arm, phase, episode, memoryDir, seq);
				// A trial that never reached the model says nothing about the arm. Stop instead of recording it as a failure.
				const spent = record.metrics.large.total;
				if (record.outcome === "error" && spent.input + spent.output + spent.cacheRead === 0) {
					throw new Error(`${arm.id} ${phase.name} ${episode.id} could not start, nothing was recorded:\n${record.error}`);
				}
				writeFileSync(file.replace(/\.json$/, ".transcript.jsonl"), `${transcript.map((line) => JSON.stringify(line)).join("\n")}\n`);
				writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
				records.push(record);
				const v = record.verdict;
				log(
					`${arm.id} ${phase.name} ${episode.id}: ${record.outcome === "completed" ? (v.success ? "PASS" : "fail") : record.outcome.toUpperCase()} ` +
						`${v.correct}/${v.items} | ${(record.wallMs / 1000).toFixed(1)}s | LLM ${record.metrics.large.total.calls} calls ` +
						`${Math.round((record.metrics.large.total.input + record.metrics.large.total.output + record.metrics.large.total.cacheRead + record.metrics.large.total.cacheWrite) / 1000)}k tok | DM ${record.metrics.decisionModel.total.calls}` +
						`${record.reused ? " | reused" : ""}${record.metrics.workflow.saved ? " | saved" : ""}${record.misapplied ? " | MISAPPLIED" : ""}` +
						`${record.error ? ` | ${record.error.split("\n")[0]}` : ""}`,
				);
			}
		}
	}
	return records;
}
