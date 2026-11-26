/** Turns trial records into a summary. Nothing is filtered out: failed and aborted trials count as failures. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARMS, type TrialRecord } from "./runner.ts";

export function loadRecords(outDir: string): TrialRecord[] {
	const records: TrialRecord[] = [];
	if (!existsSync(outDir)) return records;
	for (const rep of readdirSync(outDir).filter((name) => /^rep\d+$/.test(name))) {
		for (const arm of readdirSync(join(outDir, rep))) {
			const dir = join(outDir, rep, arm, "trials");
			if (!existsSync(dir)) continue;
			for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
				records.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as TrialRecord);
			}
		}
	}
	return records;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const total = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** Everything the model processed: fresh input, input served from the prompt cache, and output. */
const tokens = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }) => t.input + t.output + t.cacheRead + t.cacheWrite;

export interface CellSummary {
	arm: string;
	phase: string;
	trials: number;
	/** Trials whose final state was exactly right. */
	successRate: number;
	/** Items in their required state, over all items. */
	itemAccuracy: number;
	incomplete: number;
	meanWallS: number;
	meanLargeCalls: number;
	meanLargeTokens: number;
	/** Share of those tokens that were read from the prompt cache, which providers bill at a reduced rate. */
	cachedShare: number;
	/** Of the large-model tokens: agent loop, compile turns (part of the agent loop), judgments at run time, judgments during replay. */
	meanAgentTokens: number;
	meanCompileTokens: number;
	meanJudgmentTokens: number;
	meanReplayTokens: number;
	meanDecisionModelCalls: number;
	decisionModel: { adopted: number; shadow: number; audits: number; fallbacks: number; disagreements: number; llmOnly: number; viaCodemode: number };
	workflow: { saveCalls: number; saved: number; refused: number; repairs: number; divergences: number; reused: number; misapplied: number; missedReuse: number; escalations: number; failures: number; hints: number };
	sideEffects: { writes: number; noop: number; forbidden: number; collateral: number; refused: number; retriesAfterRefusal: number };
	missedItems: number;
	costUsd: number;
	jailBlocks: number;
}

export function summarize(records: TrialRecord[]) {
	const cells: CellSummary[] = [];
	const arms = [...new Set(records.map((r) => r.arm))].sort();
	const phases = [...new Set(records.map((r) => r.phase))];
	for (const arm of arms) {
		for (const phase of phases) {
			const rows = records.filter((r) => r.arm === arm && r.phase === phase);
			if (!rows.length) continue;
			const dm = (key: keyof CellSummary["decisionModel"]) => total(rows.map((r) => (key === "viaCodemode" ? r.metrics.decisionModel.codemode.calls : (r.metrics.decisionModel[key] as number))));
			const se = (key: keyof CellSummary["sideEffects"]) => total(rows.map((r) => r.verdict.sideEffects[key]));
			cells.push({
				arm,
				phase,
				trials: rows.length,
				successRate: mean(rows.map((r) => (r.verdict.success ? 1 : 0))),
				itemAccuracy: total(rows.map((r) => r.verdict.correct)) / Math.max(1, total(rows.map((r) => r.verdict.items))),
				incomplete: rows.filter((r) => r.outcome !== "completed").length,
				meanWallS: mean(rows.map((r) => r.wallMs / 1000)),
				meanLargeCalls: mean(rows.map((r) => r.metrics.large.total.calls)),
				meanLargeTokens: mean(rows.map((r) => tokens(r.metrics.large.total))),
				cachedShare: total(rows.map((r) => r.metrics.large.total.cacheRead)) / Math.max(1, total(rows.map((r) => tokens(r.metrics.large.total)))),
				meanAgentTokens: mean(rows.map((r) => tokens(r.metrics.large.agent))),
				meanCompileTokens: mean(rows.map((r) => tokens(r.metrics.large.compile))),
				meanJudgmentTokens: mean(rows.map((r) => tokens(r.metrics.large.decide) + tokens(r.metrics.large.ask))),
				meanReplayTokens: mean(rows.map((r) => tokens(r.metrics.large.replay))),
				meanDecisionModelCalls: mean(rows.map((r) => r.metrics.decisionModel.total.calls)),
				decisionModel: { adopted: dm("adopted"), shadow: dm("shadow"), audits: dm("audits"), fallbacks: dm("fallbacks"), disagreements: dm("disagreements"), llmOnly: dm("llmOnly"), viaCodemode: dm("viaCodemode") },
				workflow: {
					saveCalls: total(rows.map((r) => r.metrics.workflow.saveCalls)),
					saved: total(rows.map((r) => r.metrics.workflow.saved)),
					refused: total(rows.map((r) => r.metrics.workflow.refused)),
					repairs: total(rows.map((r) => r.metrics.workflow.repairs)),
					divergences: total(rows.map((r) => r.metrics.workflow.divergences ?? 0)),
					reused: rows.filter((r) => r.reused).length,
					misapplied: rows.filter((r) => r.misapplied).length,
					missedReuse: rows.filter((r) => r.missedReuse).length,
					escalations: total(rows.map((r) => r.metrics.workflow.escalations)),
					failures: total(rows.map((r) => r.metrics.workflow.failures)),
					hints: total(rows.map((r) => r.metrics.workflow.hints)),
				},
				sideEffects: { writes: se("writes"), noop: se("noop"), forbidden: se("forbidden"), collateral: se("collateral"), refused: se("refused"), retriesAfterRefusal: se("retriesAfterRefusal") },
				missedItems: total(rows.map((r) => r.verdict.missed)),
				costUsd: total(rows.map((r) => r.metrics.large.total.cost + r.metrics.decisionModel.total.cost)),
				jailBlocks: total(rows.map((r) => r.metrics.jailBlocks)),
			});
		}
	}

	/** Per arm and repeat, in execution order: what the arm had spent in total after each trial. */
	const cumulative = arms.flatMap((arm) =>
		[...new Set(records.filter((r) => r.arm === arm).map((r) => r.repeat))].map((repeat) => {
			let largeTokens = 0;
			let costUsd = 0;
			let wallS = 0;
			let successes = 0;
			const points = records
				.filter((r) => r.arm === arm && r.repeat === repeat)
				.sort((a, b) => a.seq - b.seq)
				.map((r) => {
					largeTokens += tokens(r.metrics.large.total);
					costUsd += r.metrics.large.total.cost + r.metrics.decisionModel.total.cost;
					wallS += r.wallMs / 1000;
					if (r.verdict.success) successes++;
					return { seq: r.seq, phase: r.phase, episode: r.episode, largeTokens, costUsd, wallS, successes };
				});
			return { arm, repeat, points };
		}),
	);

	/** How each decision site's calibration stood after each trial of an arm with memory. */
	const sites = records
		.filter((r) => r.sites.length)
		.flatMap((r) => r.sites.map((s) => ({ arm: r.arm, repeat: r.repeat, seq: r.seq, phase: r.phase, ...s })));

	return { cells, cumulative, sites };
}

export function renderMarkdown(records: TrialRecord[]): string {
	const { cells, cumulative, sites } = summarize(records);
	const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
	const n = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
	const first = records[0];
	const lines = [
		"# Experiment report",
		"",
		first ? `Model \`${first.model}\`, thinking \`${first.thinking}\`, decision model \`${records.find((r) => r.classifier)?.classifier ?? "none"}\`. ${records.length} trials.` : "No trials recorded.",
		"",
		"Every trial is a fresh session and a fresh world. A trial that timed out or errored counts as a failure.",
		"",
		"## Arms",
		"",
		...Object.values(ARMS).map((arm) => `- **${arm.id}** ${arm.label}`),
		"",
		"## Outcome and cost per phase",
		"",
		"| Arm | Phase | Trials | Success | Item acc. | Wall s | LLM calls | LLM tokens | cached | of which compile | judgments | replay | DM calls | USD |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
		...cells.map(
			(c) =>
				`| ${c.arm} | ${c.phase} | ${c.trials}${c.incomplete ? ` (${c.incomplete} incomplete)` : ""} | ${pct(c.successRate)} | ${pct(c.itemAccuracy)} | ${n(c.meanWallS)} | ${n(c.meanLargeCalls)} | ${n(c.meanLargeTokens)} | ${pct(c.cachedShare)} | ${n(c.meanCompileTokens)} | ${n(c.meanJudgmentTokens)} | ${n(c.meanReplayTokens)} | ${n(c.meanDecisionModelCalls)} | ${c.costUsd.toFixed(4)} |`,
		),
		"",
		"Wall time, calls and tokens are means per trial. Tokens count fresh input, cached input and output together; \"cached\" is the share read from the prompt cache. USD is the phase total at catalog prices.",
		"",
		"## Workflow Memory",
		"",
		"| Arm | Phase | Save calls | Saved | Refused | Repairs | Differing judgments | Hints | Reused | Misapplied | Missed reuse | Escalated | Failed runs |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|",
		...cells
			.filter((c) => ARMS[c.arm]?.memory)
			.map((c) => `| ${c.arm} | ${c.phase} | ${c.workflow.saveCalls} | ${c.workflow.saved} | ${c.workflow.refused} | ${c.workflow.repairs} | ${c.workflow.divergences} | ${c.workflow.hints} | ${c.workflow.reused} | ${c.workflow.misapplied} | ${c.workflow.missedReuse} | ${c.workflow.escalations} | ${c.workflow.failures} |`),
		"",
		"## Decision model",
		"",
		"| Arm | Phase | Adopted | Shadow | Audits | Fallbacks | Disagreements | LLM only | Via codemode |",
		"|---|---|---|---|---|---|---|---|---|",
		...cells
			.filter((c) => ARMS[c.arm]?.decisionModel)
			.map((c) => `| ${c.arm} | ${c.phase} | ${c.decisionModel.adopted} | ${c.decisionModel.shadow} | ${c.decisionModel.audits} | ${c.decisionModel.fallbacks} | ${c.decisionModel.disagreements} | ${c.decisionModel.llmOnly} | ${c.decisionModel.viaCodemode} |`),
		"",
		"## Side effects",
		"",
		"| Arm | Phase | Writes | No-op | Forbidden | Collateral | Refused | Retries after refusal | Missed items | Jail blocks |",
		"|---|---|---|---|---|---|---|---|---|---|",
		...cells.map(
			(c) =>
				`| ${c.arm} | ${c.phase} | ${c.sideEffects.writes} | ${c.sideEffects.noop} | ${c.sideEffects.forbidden} | ${c.sideEffects.collateral} | ${c.sideEffects.refused} | ${c.sideEffects.retriesAfterRefusal} | ${c.missedItems} | ${c.jailBlocks} |`,
		),
		"",
		"## Cumulative large-model tokens",
		"",
		...cumulative.map((c) => `- **${c.arm}** rep ${c.repeat}: ${c.points.map((p) => `${p.seq}:${Math.round(p.largeTokens / 1000)}k`).join(" ")}`),
		"",
		"## Decision site calibration",
		"",
		sites.length ? "| Arm | Rep | After trial | Phase | Workflow | Site | Tier | Tau | Samples | Agreement |" : "No decision sites recorded.",
		...(sites.length ? ["|---|---|---|---|---|---|---|---|---|---|"] : []),
		...sites.map((s) => `| ${s.arm} | ${s.repeat} | ${s.seq} | ${s.phase} | ${s.workflow} | ${s.site} | ${s.tier} | ${s.tau} | ${s.samples} | ${s.agreement === null ? "-" : pct(s.agreement)} |`),
		"",
		"## Trials",
		"",
		"| Arm | # | Phase | Episode | Kind | Result | Items | LLM tok | Notes |",
		"|---|---|---|---|---|---|---|---|---|",
		...records
			.slice()
			.sort((a, b) => a.arm.localeCompare(b.arm) || a.repeat - b.repeat || a.seq - b.seq)
			.map((r) => {
				const notes = [
					r.reused && "reused",
					r.metrics.workflow.saved && `saved ${r.metrics.workflow.acquired.join(",")}`,
					r.metrics.workflow.refused && `${r.metrics.workflow.refused} refused`,
					r.misapplied && "MISAPPLIED",
					r.missedReuse && "missed reuse",
					r.metrics.workflow.escalations && "escalated",
					r.verdict.sideEffects.forbidden && `${r.verdict.sideEffects.forbidden} forbidden`,
					r.error && r.error.split("\n")[0].slice(0, 80),
				].filter(Boolean);
				const result = r.outcome !== "completed" ? r.outcome : r.verdict.success ? "pass" : "fail";
				return `| ${r.arm} | ${r.seq} | ${r.phase} | ${r.episode} | ${r.kind} | ${result} | ${r.verdict.correct}/${r.verdict.items} | ${tokens(r.metrics.large.total)} | ${notes.join("; ")} |`;
			}),
		"",
	];
	return lines.join("\n");
}

export function writeReport(outDir: string): string {
	const records = loadRecords(outDir);
	writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summarize(records), null, 1)}\n`);
	const markdown = renderMarkdown(records);
	writeFileSync(join(outDir, "report.md"), markdown);
	return markdown;
}
