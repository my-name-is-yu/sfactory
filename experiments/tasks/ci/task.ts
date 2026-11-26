/**
 * CI Failure Triage: a mock CI served through ci_* tools, the episodes built from scenarios, and a
 * verifier that reads only the saved diagnoses and the write log.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Episode, Instance, Split, Task, Verdict } from "../../lib/types.ts";
import { rng } from "../../lib/types.ts";
import { type DiffFile, SCENARIOS, UNRELATED_DIFFS } from "./scenarios.ts";

export const CI_GUIDE = `CI FAILURE TRIAGE GUIDE

For every failed run, save exactly one diagnosis (ci_save_diagnosis) with a category, a cause_key and a one-line summary.

Categories
- regression: the pull request's own change to product or test code broke it. The failing code is touched by the diff, and the job is green on main.
- flaky: a test that also fails now and then on main without related changes. The diff does not touch what failed.
- infra: the runner or its surroundings failed, not the code: killed for memory, disk full, runner lost, registry or network outage.
- dependency: something upstream changed under an unchanged manifest: a package or base image resolves to a different version than in recent green runs, and the diff did not ask for it.
- config: the pipeline itself is wrong: a missing secret, an invalid workflow file, a tool version pinned in CI configuration. This also applies when the pull request changed the CI configuration and that change is what fails.
- unknown: the evidence does not support any of the above. Do not guess.

Rules
- Decide from evidence: the first real error in the log, whether the diff touches what failed, and how the job behaved on main recently (ci_history; the logs of those runs can be read too). The last lines of a log and alarming keywords are often consequences, not causes.
- cause_key: failed runs with the same root cause must share one key, and runs with different root causes must have different keys. Any short lowercase text will do.
- Do not save a diagnosis for a run that did not fail, or for runs you were not asked about.
- If a log cannot be fetched, try once more. If it still cannot be fetched, save the run as unknown and say so in the summary.`;

const CANON =
	"Triage the failed CI runs. Follow the CI triage guide (ci_guide): for every failed run, find the root cause from its log, the pull request's diff and the job's recent history on main, and save a diagnosis with ci_save_diagnosis. Runs with the same root cause must share a cause_key. At the end, check that every failed run has a diagnosis and tell me which ones you could not determine.";
const PROMPTS = [
	CANON,
	"Please go through the failed CI runs and diagnose each one according to the CI triage guide (ci_guide). Use the log, the PR diff and the job's history on main to find the root cause, and record it with ci_save_diagnosis; runs that failed for the same reason get the same cause_key. Make sure no failed run is left without a diagnosis and report any you could not determine.",
	"CI is red on several runs. For each failed run work out why, following ci_guide: read the log, compare with the pull request's diff and with how the job did on main, then save the diagnosis (ci_save_diagnosis), using one cause_key per root cause. Verify at the end that all failed runs are covered and list the ones that stayed unclear.",
	"失敗したCI Runを調査してください。CIトリアージガイド(ci_guide)に従い、各Runについてログ、PRのDiff、mainでの過去の実行結果から根本原因を特定し、ci_save_diagnosisで診断を保存します。同じ原因のRunには同じcause_keyを付けてください。最後に、失敗したRunすべてに診断があることを確認し、特定できなかったものを報告してください。",
];
const ONLY_PR = (pr: number) =>
	`Diagnose only the failed CI runs of pull request #${pr}, following the CI triage guide (ci_guide): find the root cause from the log, the diff and the job's history on main, and save a diagnosis with ci_save_diagnosis. Do not save anything for other pull requests' runs.`;
const COUNT_ONLY = "How many CI runs failed per job? Answer in your reply. This is a count only: do not investigate causes and do not save any diagnosis.";

interface Run {
	id: string;
	job: string;
	branch: string;
	pr: number | null;
	sha: string;
	status: "failed" | "passed";
}

interface Gold {
	category: string;
	key: string;
}

export interface CiEpisode extends Episode {
	runs: Run[];
	logs: Record<string, string[]>;
	diffs: Record<number, DiffFile[]>;
	history: Record<string, { id: string; status: string; failed_tests: string[] }[]>;
	/** Runs whose log can never be fetched, and runs whose first fetch fails. */
	logGone: string[];
	logFlaky: string[];
	/** Failed runs the request covers, with their gold. Only the verifier reads this. */
	gold: Record<string, Gold>;
}

const PASSING = ["PASS tests/cart/add.test.ts", "PASS tests/cart/remove.test.ts", "PASS tests/auth/session.test.ts", "PASS tests/orders/list.test.ts", "PASS tests/search/query.test.ts", "PASS tests/util/slug.test.ts", "PASS tests/billing/tax.test.ts", "PASS tests/realtime/presence.test.ts"];

function logFor(step: string, sha: string, install: string | undefined, body: string[], after: string[], failed: boolean, next: () => number): string[] {
	const filler = Array.from({ length: 6 + Math.floor(next() * 10) }, () => PASSING[Math.floor(next() * PASSING.length)]);
	return [
		"##[group]Run actions/checkout@v4",
		"Syncing repository: acme/orders",
		`HEAD is now at ${sha}`,
		"##[endgroup]",
		"##[group]Set up runtime",
		"Cache restored from key: deps-linux-7f1c",
		"warning: retrying fetch after ECONNRESET (attempt 1/3)",
		"fetch ok",
		install ?? "dependencies up to date, 1243 packages",
		"npm warn deprecated inflight@1.0.6: This module is not supported",
		"(node:1820) Warning: the timeout option is deprecated",
		"##[endgroup]",
		`##[group]Run ${step}`,
		...filler,
		...body,
		...after,
		"##[endgroup]",
		...(failed ? ["##[error]Process completed with exit code 1."] : ["All checks passed."]),
		"Post job cleanup.",
		"Cleaning up orphan processes",
		...Array.from({ length: 34 }, (_, i) => `[cleanup] removed temp artefact ${i + 1}/34`),
	];
}

interface Spec {
	scenarios: string[];
	passing?: number;
	prompt: string | ((prs: number[]) => string);
	/** Limit the request to the first PR; other failed runs must stay undiagnosed. */
	onlyFirstPr?: boolean;
	/** No run is to be diagnosed at all. */
	none?: boolean;
	logGone?: number;
	logFlaky?: number;
}

function build(id: string, split: Split, kind: string, reuse: Episode["reuse"], spec: Spec): CiEpisode {
	const next = rng(`ci/${id}`);
	const runs: Run[] = [];
	const logs: Record<string, string[]> = {};
	const diffs: Record<number, DiffFile[]> = {};
	const allGold: Record<string, Gold> = {};
	const history: CiEpisode["history"] = {};
	const used = new Set<string>();
	const newId = () => {
		let value: string;
		do value = `r${10000 + Math.floor(next() * 90000)}`;
		while (used.has(value));
		used.add(value);
		return value;
	};
	const sha = () => Math.floor(next() * 0xfffffff).toString(16).padStart(7, "0");
	let pr = 400 + Math.floor(next() * 300);
	let unrelated = Math.floor(next() * UNRELATED_DIFFS.length);
	const prs: number[] = [];

	for (const name of spec.scenarios) {
		const scenario = SCENARIOS[name];
		const sharedPr = scenario.acrossPrs ? null : ++pr;
		if (sharedPr) diffs[sharedPr] = scenario.diff ?? UNRELATED_DIFFS[unrelated++ % UNRELATED_DIFFS.length];
		for (const failing of scenario.runs) {
			const runPr = sharedPr ?? ++pr;
			if (!sharedPr) diffs[runPr] = UNRELATED_DIFFS[unrelated++ % UNRELATED_DIFFS.length];
			prs.push(runPr);
			const run: Run = { id: newId(), job: failing.job, branch: `pr-${runPr}`, pr: runPr, sha: sha(), status: "failed" };
			runs.push(run);
			logs[run.id] = logFor(failing.step, run.sha, scenario.install?.now, failing.error, failing.after ?? [], true, next);
			allGold[run.id] = { category: scenario.category, key: scenario.key };

			// Ten recent main runs of the job. A cause that also shows on main leaves its mark there.
			const rows = (history[failing.job] ??= Array.from({ length: 10 }, () => ({ id: newId(), status: "passed", failed_tests: [] as string[] })));
			rows.forEach((row, at) => {
				const fails = scenario.mainFailures?.at.includes(at);
				if (fails) {
					row.status = "failed";
					row.failed_tests = [...new Set([...row.failed_tests, ...(scenario.mainFailures?.tests ?? [])])];
				}
				const error = fails ? (scenario.mainFailures?.error ? [scenario.mainFailures.error] : (scenario.mainFailures?.tests ?? []).map((t) => `FAIL ${t}`)) : [];
				const installLine = scenario.install ? (fails ? scenario.install.now : scenario.install.green) : undefined;
				// Keep the most informative log when several scenarios share a job.
				if (!logs[row.id] || fails || installLine) logs[row.id] = logFor(failing.step, sha(), installLine, error, [], row.status === "failed", next);
			});
		}
	}
	for (let i = 0; i < (spec.passing ?? 2); i++) {
		const run: Run = { id: newId(), job: ["unit", "lint", "build"][i % 3], branch: `pr-${++pr}`, pr, sha: sha(), status: "passed" };
		diffs[pr] = UNRELATED_DIFFS[unrelated++ % UNRELATED_DIFFS.length];
		runs.push(run);
		logs[run.id] = logFor("npm test", run.sha, undefined, [], [], false, next);
	}
	// Order must not reveal which runs belong together.
	for (let i = runs.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[runs[i], runs[j]] = [runs[j], runs[i]];
	}

	const failed = runs.filter((run) => run.status === "failed");
	const logGone = failed.slice(0, spec.logGone ?? 0).map((run) => run.id);
	const logFlaky = failed.slice(spec.logGone ?? 0, (spec.logGone ?? 0) + (spec.logFlaky ?? 0)).map((run) => run.id);
	// A run whose log can never be read cannot be diagnosed: the guide makes it unknown.
	for (const runId of logGone) allGold[runId] = { category: "unknown", key: `unreadable_${runId}` };

	const gold: Record<string, Gold> = {};
	for (const run of failed) {
		if (spec.none) continue;
		if (spec.onlyFirstPr && run.pr !== prs[0]) continue;
		gold[run.id] = allGold[run.id];
	}
	const prompt = typeof spec.prompt === "function" ? spec.prompt(prs) : spec.prompt;
	return { id: `ci/${id}`, task: "ci", split, kind, reuse, prompt, runs, logs, diffs, history, logGone, logFlaky, gold };
}

export function ciEpisodes(): CiEpisode[] {
	return [
		build("train-1", "train", "standard", "expected", { scenarios: ["price_rounding", "ws_reconnect_flaky", "runner_oom"], prompt: PROMPTS[0] }),
		build("train-2", "train", "standard", "expected", { scenarios: ["eslint_plugin_major", "missing_deploy_token", "null_user_serializer"], prompt: PROMPTS[1] }),
		build("calib-1", "calib", "standard", "expected", { scenarios: ["queue_deadlock", "registry_503", "midnight_date_flaky", "ci_node_pin"], prompt: PROMPTS[2] }),
		build("calib-2", "calib", "standard", "expected", { scenarios: ["migration_missing_column", "base_image_python", "disk_full"], prompt: PROMPTS[0] }),
		build("test-1", "test", "standard", "expected", { scenarios: ["order_id_type", "cache_order_flaky", "runner_lost", "workflow_syntax"], prompt: PROMPTS[1] }),
		build("test-2", "test", "standard", "expected", { scenarios: ["button_snapshot", "protobuf_transitive", "truncated_log", "unexplained_failure"], prompt: PROMPTS[2] }),
		// Adaptation episodes re-instantiate causes from earlier splits under new conditions.
		build("adapt-paraphrase", "adapt", "paraphrase", "expected", { scenarios: ["price_rounding", "registry_503", "cache_order_flaky"], prompt: PROMPTS[3] }),
		build("adapt-volume", "adapt", "volume", "expected", {
			scenarios: ["queue_deadlock", "ws_reconnect_flaky", "eslint_plugin_major", "disk_full", "ci_node_pin", "null_user_serializer", "base_image_python", "runner_oom", "midnight_date_flaky"],
			passing: 6,
			prompt: PROMPTS[0],
		}),
		build("adapt-partial", "adapt", "partial", "expected", { scenarios: ["migration_missing_column", "registry_503", "missing_deploy_token", "button_snapshot"], prompt: PROMPTS[1], logGone: 1, logFlaky: 1 }),
		build("adapt-one-pr", "adapt", "param", "possible", { scenarios: ["price_rounding", "runner_lost", "protobuf_transitive"], prompt: (prs) => ONLY_PR(prs[0]), onlyFirstPr: true }),
		build("adapt-count-only", "adapt", "distractor", "wrong", { scenarios: ["order_id_type", "ws_reconnect_flaky", "disk_full"], prompt: COUNT_ONLY, none: true }),
	];
}

interface Save {
	run: string;
	ok: boolean;
	changed: boolean;
}

class MockCi {
	readonly diagnoses = new Map<string, { category: string; cause_key: string; summary: string }>();
	readonly log: Save[] = [];
	readonly episode: CiEpisode;
	private readonly failedOnce = new Set<string>();

	constructor(episode: CiEpisode) {
		this.episode = episode;
	}

	readLog(runId: string, grep: string | undefined, start: number | undefined, limit: number | undefined) {
		const lines = this.episode.logs[runId];
		if (!lines) throw new Error(`no run ${runId}`);
		if (this.episode.logGone.includes(runId)) throw new Error(`log storage returned 404 for run ${runId}: the log has expired`);
		if (this.episode.logFlaky.includes(runId) && !this.failedOnce.has(runId)) {
			this.failedOnce.add(runId);
			throw new Error("log service timed out, try again");
		}
		const numbered = lines.map((text, i) => ({ n: i + 1, text }));
		if (grep) {
			const needle = grep.toLowerCase();
			return { total_lines: lines.length, lines: numbered.filter((line) => line.text.toLowerCase().includes(needle)).slice(0, 60).map((line) => `${line.n}: ${line.text}`) };
		}
		const count = Math.min(limit ?? 40, 200);
		const from = start ? Math.max(1, start) : Math.max(1, lines.length - count + 1);
		return { total_lines: lines.length, lines: numbered.slice(from - 1, from - 1 + count).map((line) => `${line.n}: ${line.text}`) };
	}

	save(runId: string, category: string, causeKey: string, summary: string) {
		if (!this.episode.runs.some((run) => run.id === runId)) {
			this.log.push({ run: runId, ok: false, changed: false });
			throw new Error(`no run ${runId}`);
		}
		const next = { category, cause_key: causeKey, summary };
		const changed = JSON.stringify(this.diagnoses.get(runId)) !== JSON.stringify(next);
		this.diagnoses.set(runId, next);
		this.log.push({ run: runId, ok: true, changed });
	}
}

function ciExtension(ci: MockCi) {
	const episode = ci.episode;
	return (pi: ExtensionAPI) => {
		const namespace = { name: "ci", description: "The CI system: failed runs, their logs, pull request diffs, job history and saved diagnoses" };
		const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }], details: undefined, structuredContent: value as never });
		const read = { readOnlyHint: true };
		const RunSchema = Type.Object({ id: Type.String(), job: Type.String(), branch: Type.String(), pr: Type.Union([Type.Number(), Type.Null()]), sha: Type.String(), status: Type.String() });

		pi.registerTool({
			name: "ci_guide",
			label: "CI triage guide",
			description: "Read the CI triage guide: the failure categories and the rules for diagnosing a run.",
			parameters: Type.Object({}),
			outputSchema: Type.Object({ guide: Type.String() }),
			annotations: read,
			namespace,
			async execute() {
				return json({ guide: CI_GUIDE });
			},
		});
		pi.registerTool({
			name: "ci_list_runs",
			label: "List CI runs",
			description: "List recent pull request CI runs, optionally only those with a given status (failed, passed).",
			parameters: Type.Object({ status: Type.Optional(Type.String()) }),
			outputSchema: Type.Object({ runs: Type.Array(RunSchema) }),
			annotations: read,
			namespace,
			async execute(_id, params) {
				return json({ runs: episode.runs.filter((run) => !params.status || run.status === params.status) });
			},
		});
		pi.registerTool({
			name: "ci_get_log",
			label: "Get CI log",
			description:
				"Read a run's log. Without options it returns the last 40 lines. Use grep to get only lines containing a text (case-insensitive), " +
				"or start and limit to read a range of line numbers. Works for the main-branch runs listed by ci_history too.",
			parameters: Type.Object({ run_id: Type.String(), grep: Type.Optional(Type.String()), start: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
			outputSchema: Type.Object({ total_lines: Type.Number(), lines: Type.Array(Type.String()) }),
			annotations: read,
			namespace,
			async execute(_id, params) {
				return json(ci.readLog(params.run_id, params.grep, params.start, params.limit));
			},
		});
		pi.registerTool({
			name: "ci_get_diff",
			label: "Get PR diff",
			description: "Read the files a pull request changes, with their patches.",
			parameters: Type.Object({ pr: Type.Number() }),
			outputSchema: Type.Object({ files: Type.Array(Type.Object({ path: Type.String(), patch: Type.String() })) }),
			annotations: read,
			namespace,
			async execute(_id, params) {
				const files = episode.diffs[params.pr];
				if (!files) throw new Error(`no pull request #${params.pr}`);
				return json({ files });
			},
		});
		pi.registerTool({
			name: "ci_history",
			label: "Job history on main",
			description: "The last ten runs of a job on the main branch, most recent first, with the tests that failed in each.",
			parameters: Type.Object({ job: Type.String() }),
			outputSchema: Type.Object({ runs: Type.Array(Type.Object({ id: Type.String(), status: Type.String(), failed_tests: Type.Array(Type.String()) })) }),
			annotations: read,
			namespace,
			async execute(_id, params) {
				return json({ runs: episode.history[params.job] ?? [] });
			},
		});
		pi.registerTool({
			name: "ci_save_diagnosis",
			label: "Save diagnosis",
			description: "Save the diagnosis of one failed run. Saving again for the same run replaces the earlier diagnosis.",
			parameters: Type.Object({
				run_id: Type.String(),
				category: Type.String({ description: "regression, flaky, infra, dependency, config or unknown" }),
				cause_key: Type.String({ description: "Shared by all runs with the same root cause" }),
				summary: Type.String(),
			}),
			outputSchema: Type.Object({ run_id: Type.String(), saved: Type.Boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			namespace,
			executionMode: "sequential",
			async execute(_id, params) {
				ci.save(params.run_id, params.category, params.cause_key, params.summary);
				return json({ run_id: params.run_id, saved: true });
			},
		});
	};
}

export function verifyCi(episode: CiEpisode, ci: MockCi): Verdict {
	const inScope = Object.keys(episode.gold);
	const key = (runId: string) => ci.diagnoses.get(runId)?.cause_key.trim().toLowerCase();
	// Grouping is judged among runs with a known cause: each must share its key with exactly its gold peers.
	const known = inScope.filter((runId) => episode.gold[runId].category !== "unknown");
	const errors: string[] = [];
	let correct = 0;
	let missed = 0;
	for (const runId of inScope) {
		const gold = episode.gold[runId];
		const saved = ci.diagnoses.get(runId);
		if (!saved) {
			missed++;
			errors.push(`${runId}: no diagnosis (expected ${gold.category})`);
			continue;
		}
		const categoryOk = saved.category.trim().toLowerCase() === gold.category;
		let groupOk = true;
		if (gold.category !== "unknown") {
			const peersGold = known.filter((other) => episode.gold[other].key === gold.key).sort().join();
			const peersSaved = known.filter((other) => key(other) !== undefined && key(other) === key(runId)).sort().join();
			groupOk = peersGold === peersSaved;
		}
		if (categoryOk && groupOk) correct++;
		else errors.push(`${runId}: ${categoryOk ? "" : `category ${saved.category}, expected ${gold.category}`}${categoryOk || groupOk ? "" : "; "}${groupOk ? "" : "grouped with the wrong runs"}`);
	}
	const collateral = [...ci.diagnoses.keys()].filter((runId) => !inScope.includes(runId)).length;
	const ok = ci.log.filter((save) => save.ok);
	return {
		success: correct === inScope.length && collateral === 0,
		correct,
		items: inScope.length,
		missed,
		sideEffects: {
			writes: ok.length,
			noop: ok.filter((save) => !save.changed).length,
			forbidden: ok.filter((save) => !inScope.includes(save.run)).length,
			collateral,
			refused: ci.log.length - ok.length,
			retriesAfterRefusal: 0,
		},
		errors,
		notes: { resaved: ok.length - new Set(ok.map((save) => save.run)).size },
	};
}

export const ciTask: Task = {
	name: "ci",
	episodes: ciEpisodes,
	instantiate(episode): Instance {
		const full = episode as CiEpisode;
		const ci = new MockCi(full);
		return { extension: ciExtension(ci), verify: () => verifyCi(full, ci) };
	},
};
