/**
 * The experiment harness itself: datasets, isolation of gold, verifiers, and the runner's
 * measurements. The runner tests drive real Pi sessions with a scripted model that judges tickets
 * by crude keywords, so they check the plumbing, not how well anything solves the task.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TraceStore } from "../extensions/sfactory/src/store.ts";
import { loadRecords, renderMarkdown, summarize } from "../experiments/lib/report.ts";
import { ARMS, PHASES, type RunOptions, runSuite, runTrial } from "../experiments/lib/runner.ts";
import { type CiEpisode, ciEpisodes, ciTask } from "../experiments/tasks/ci/task.ts";
import { type TicketEpisode, ticketEpisodes } from "../experiments/tasks/tickets/dataset.ts";
import { MemoryDesk, ticketsTask, verifyTickets } from "../experiments/tasks/tickets/task.ts";

const GOLD_WORDS = /"(expected|gold|category|key)"|unassigned|"(billing|technical|account|product|security)"/;

test("ticket splits are disjoint and large enough", () => {
	const episodes = ticketEpisodes();
	const bySplit = new Map<string, Set<string>>();
	for (const episode of episodes) {
		if (episode.kind === "distractor") continue; // distractors reuse training tickets on purpose
		const seen = (bySplit.get(episode.split) ?? bySplit.set(episode.split, new Set()).get(episode.split))!;
		for (const ticket of episode.tickets) {
			assert.ok(!seen.has(ticket.body), `duplicate ticket inside ${episode.split}: ${ticket.subject}`);
			seen.add(ticket.body);
		}
	}
	const splits = [...bySplit.keys()];
	for (const a of splits) for (const b of splits) if (a < b) for (const body of bySplit.get(a)!) assert.ok(!bySplit.get(b)!.has(body), `ticket shared by ${a} and ${b}`);
	assert.deepEqual(Object.fromEntries([...bySplit].map(([split, set]) => [split, set.size])), { train: 24, calib: 36, test: 32, adapt: 67 });
	const ids = episodes.flatMap((e) => e.tickets.map((t) => `${e.id}:${t.id}`));
	assert.equal(new Set(ids).size, ids.length);
});

test("what the desk serves contains no gold", () => {
	for (const episode of ticketEpisodes()) {
		const desk = new MemoryDesk(episode);
		const served = JSON.stringify([desk.list({}), ...desk.tickets.map((t) => desk.get(t.id))]);
		assert.ok(!GOLD_WORDS.test(served) || episode.kind === "distractor", `${episode.id} leaks gold: ${GOLD_WORDS.exec(served)?.[0]}`);
	}
});

/** Bring the desk to the required state through its own write interface, the way a perfect agent would. */
function solve(episode: TicketEpisode, desk: MemoryDesk) {
	for (const ticket of episode.tickets) {
		const want = episode.expected[ticket.id];
		const patch: Record<string, string> = {};
		if (want.label !== ticket.label && want.label) patch.label = want.label;
		if (want.priority !== ticket.priority && want.priority) patch.priority = want.priority;
		if (want.status !== ticket.status) patch.status = want.status;
		const write = (action: () => void) => {
			try {
				action();
			} catch (error) {
				if (/temporarily unavailable/.test(String(error))) action();
				else if (!/locked/.test(String(error))) throw error;
			}
		};
		if (Object.keys(patch).length) write(() => desk.update(ticket.id, patch));
		if (want.draft) write(() => desk.draft(ticket.id, "We are on it."));
	}
}

test("the ticket verifier passes exactly the required final state", () => {
	for (const episode of ticketEpisodes()) {
		const untouched = new MemoryDesk(episode);
		const idle = verifyTickets(episode, untouched, "");
		assert.equal(idle.success, false, `${episode.id}: doing nothing must fail`);
		assert.equal(idle.missed, idle.items);

		const desk = new MemoryDesk(episode);
		solve(episode, desk);
		const verdict = verifyTickets(episode, desk, "");
		assert.equal(verdict.success, true, `${episode.id}: ${verdict.errors.join("; ")}`);
		assert.equal(verdict.sideEffects.forbidden + verdict.sideEffects.noop + verdict.sideEffects.collateral, 0, episode.id);
		assert.deepEqual(verifyTickets(episode, desk, ""), verdict, "the verifier is deterministic");
	}
});

test("the ticket verifier counts wrong, repeated and forbidden changes", () => {
	const episode = ticketEpisodes().find((e) => e.id === "tickets/adapt-pending")!;
	const desk = new MemoryDesk(episode);
	solve(episode, desk);
	const bystander = episode.tickets.find((t) => t.status === "open")!;
	desk.update(bystander.id, { label: "billing", status: "triaged" });
	const pending = episode.tickets.find((t) => t.status === "pending")!;
	desk.update(pending.id, { status: "triaged" });
	const verdict = verifyTickets(episode, desk, "");
	assert.equal(verdict.success, false);
	assert.deepEqual([verdict.sideEffects.forbidden, verdict.sideEffects.collateral, verdict.sideEffects.noop], [1, 1, 1]);
	assert.equal(verdict.correct, verdict.items, "the requested tickets themselves are right");

	const partial = ticketEpisodes().find((e) => e.id === "tickets/adapt-partial")!;
	const stubborn = new MemoryDesk(partial);
	for (let i = 0; i < 3; i++) assert.throws(() => stubborn.update(partial.locked[0], { status: "triaged" }), /locked/);
	assert.throws(() => stubborn.update(partial.flaky[0], { label: "x" }), /temporarily unavailable/);
	stubborn.update(partial.flaky[0], { label: "x" });
	const refused = verifyTickets(partial, stubborn, `could not update ${partial.locked[0]}`);
	assert.deepEqual([refused.sideEffects.refused, refused.sideEffects.retriesAfterRefusal, refused.notes.lockedReported], [4, 2, 1]);
});

test("long queues come in pages", () => {
	const episode = ticketEpisodes().find((e) => e.id === "tickets/adapt-volume")!;
	const desk = new MemoryDesk(episode);
	const first = desk.list({ status: "open" });
	assert.equal(first.tickets.length, 10);
	let seen = first.tickets.length;
	for (let page = first; page.next_cursor; ) {
		page = desk.list({ status: "open", cursor: page.next_cursor });
		seen += page.tickets.length;
	}
	assert.equal(seen, 26);
	assert.equal(desk.list({ status: "open" }).tickets.length, 10);
	for (const e of ticketEpisodes().filter((e) => e.split === "train")) assert.equal(new MemoryDesk(e).list({ status: "open" }).next_cursor, undefined, "training never shows a second page");
});

test("the CI verifier checks categories and grouping, and its world hides gold", async () => {
	for (const episode of ciEpisodes()) {
		const served = JSON.stringify([episode.runs, episode.logs, episode.diffs, episode.history]);
		for (const gold of Object.values(episode.gold)) assert.ok(!served.includes(gold.key), `${episode.id} leaks cause key ${gold.key}`);

		const save = async (pick: (runId: string) => { category: string; cause_key: string } | undefined) => {
			const instance = ciTask.instantiate(episode);
			const tools = new Map<string, any>();
			instance.extension({ registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
			for (const run of (episode as CiEpisode).runs) {
				const diagnosis = pick(run.id);
				if (diagnosis) await tools.get("ci_save_diagnosis").execute("t", { run_id: run.id, summary: "s", ...diagnosis });
			}
			return instance.verify("");
		};
		const perfect = await save((id) => (episode.gold[id] ? { category: episode.gold[id].category, cause_key: `k-${episode.gold[id].key}` } : undefined));
		assert.equal(perfect.success, true, `${episode.id}: ${perfect.errors.join("; ")}`);
		if (!Object.keys(episode.gold).length) continue;
		const lumped = await save((id) => (episode.gold[id] ? { category: episode.gold[id].category, cause_key: "same" } : undefined));
		const causes = new Set(Object.values(episode.gold).filter((g) => g.category !== "unknown").map((g) => g.key));
		assert.equal(lumped.success, causes.size <= 1, `${episode.id}: one key for every run must fail when causes differ`);
		const everything = await save((id) => ({ category: episode.gold[id]?.category ?? "flaky", cause_key: `k-${episode.gold[id]?.key ?? id}` }));
		assert.equal(everything.success, false, `${episode.id}: diagnosing runs that were not asked for must fail`);
		assert.ok(everything.sideEffects.forbidden > 0);
	}
});

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

/** Deliberately crude: looks at words only. It is wrong on purpose on the tickets built to defeat that. */
function byKeywords(ticket: { subject: string; body: string }) {
	const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
	const label = /charge|refund|invoice|billed|plan/.test(text) ? "billing" : /crash|error|sync|slow|fail/.test(text) ? "technical" : /login|sign in|password|access/.test(text) ? "account" : "product";
	return { label, priority: /urgent|asap|today|now/.test(text) ? "urgent" : "normal" };
}

const WORKFLOW = `const { tickets } = await tools.tickets_list({ status: input.status });
const full = await Promise.all(tickets.map((t) => tools.tickets_get({ id: t.id })));
for (const t of full) {
  const state = { subject: t.subject, body: t.body };
  const team = await decide({ id: "team", state, type: "choice", instructions: "Which team handles this ticket?",
    criteria: { billing: "money", technical: "defects", account: "access", product: "everything else" } });
  const urgent = await decide({ id: "urgent", state, type: "bool", instructions: "Is it urgent?", criteria: { true: "blocked now", false: "can wait" } });
  await tools.tickets_update({ id: t.id, label: team.answer, priority: urgent.answer ? "urgent" : "normal", status: "triaged" });
}
return { triaged: full.length };`;

function scriptedModel() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
	const mode = { value: "cold" as "cold" | "cold+save" | "workflow" | "snoop", memory: "" };
	const call = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const respond = (context: { messages: any[] }): AssistantMessage => {
		const last = context.messages.at(-1);
		const lastText = typeof last?.content === "string" ? last.content : "";
		if (last?.role === "user" && lastText.includes('Reply {"answer"')) {
			const verdict = byKeywords(JSON.parse(lastText.slice(lastText.lastIndexOf("State:") + 6)));
			return fauxAssistantMessage(JSON.stringify({ answer: lastText.includes('Reply {"answer": true}') ? verdict.priority === "urgent" : verdict.label }));
		}
		const start = context.messages.findLastIndex((m) => m.role === "user");
		const results = context.messages.slice(start + 1).filter((m) => m.role === "toolResult");
		const json = (m: any) => JSON.parse(m.content.map((c: any) => c.text ?? "").join(""));
		const done = (name: string) => results.filter((m) => m.toolName === name);
		if (mode.value === "snoop") {
			return results.length ? fauxAssistantMessage([fauxText("Could not read it.")]) : call(fauxToolCall("read", { path: join(import.meta.dirname, "..", "experiments", "tasks", "tickets", "data", "test.ts") }));
		}
		if (mode.value === "workflow") {
			return results.length ? fauxAssistantMessage([fauxText("Done with the workflow.")]) : call(fauxToolCall("wf_triage", { status: "open" }));
		}
		if (!done("tickets_list").length) return call(fauxToolCall("tickets_list", { status: "open" }));
		const ids: string[] = json(done("tickets_list")[0]).tickets.map((t: any) => t.id);
		if (!done("tickets_get").length) return call(...ids.map((id) => fauxToolCall("tickets_get", { id })));
		if (!done("tickets_update").length) {
			return call(
				...done("tickets_get").map((m) => {
					const ticket = json(m);
					const verdict = byKeywords(ticket);
					return fauxToolCall("tickets_update", { id: ticket.id, label: verdict.label, priority: verdict.priority, status: "triaged" });
				}),
			);
		}
		if (mode.value === "cold+save" && !done("workflow_save").length) {
			const earlier = new TraceStore(join(mode.memory, ".pi", "traces")).list().map((trace) => trace.id);
			return call(
				fauxToolCall("workflow_save", {
					name: "triage",
					description: "Triage the tickets of a given status: team label, priority, status triaged. Not for other desk chores.",
					input_schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
					code: WORKFLOW,
					examples: [...earlier, "current"].map((trace) => ({ trace, input: { status: "open" } })),
				}),
			);
		}
		return fauxAssistantMessage([fauxText("Triage finished.")]);
	};
	faux.setResponses(Array.from({ length: 2000 }, () => respond as never));
	return { faux, mode };
}

function options(outDir: string, faux: ReturnType<typeof scriptedModel>["faux"], extra: Partial<RunOptions> = {}): RunOptions {
	return {
		task: ticketsTask,
		arms: [ARMS.A],
		phases: [PHASES.train],
		model: faux.getModel(),
		outDir,
		agentDir: join(outDir, "agent"),
		extensions: [(pi: ExtensionAPI) => pi.registerProvider(faux.provider)],
		timeoutMs: 60_000,
		...extra,
	};
}

test("the runner scores a trial, counts its model calls and keeps gold out of reach", { timeout: 120_000 }, async () => {
	const out = mkdtempSync(join(tmpdir(), "sfactory-exp-"));
	const { faux, mode } = scriptedModel();
	const episode = ticketsTask.episodes()[0];

	mode.value = "cold";
	const cold = await runTrial(options(out, faux), ARMS.A, PHASES.train, episode, join(out, "memory"), 1);
	assert.equal(cold.record.outcome, "completed", cold.record.error);
	assert.equal(cold.record.metrics.large.agent.calls, 4, "list, read all, update all, answer");
	assert.equal(cold.record.metrics.large.total.calls, 4);
	assert.equal(cold.record.verdict.items, 8);
	assert.equal(cold.record.verdict.sideEffects.writes, 8);
	assert.equal(cold.record.verdict.success, false, "keywords alone do not solve the queue");
	assert.ok(cold.record.verdict.correct < 8 && cold.record.verdict.correct > 0);
	assert.equal(cold.record.metrics.tools.tickets_update.calls, 8);
	assert.ok(!existsSync(join(out, "memory", ".pi")), "an arm without memory leaves nothing behind");

	mode.value = "snoop";
	const snoop = await runTrial(options(out, faux), ARMS.B, PHASES.train, episode, join(out, "memory"), 2);
	assert.equal(snoop.record.metrics.jailBlocks, 1, "reading the dataset is blocked");
	assert.equal(snoop.record.metrics.tools.read.errors, 1);
	assert.equal(snoop.record.verdict.success, false);
	for (const tool of ["bash", "edit", "write", "grep", "find", "ls"]) assert.ok(!(tool in snoop.record.metrics.tools), `${tool} is not offered`);
});

test("memory carries over within an arm, and a frozen phase neither learns nor leaks", { timeout: 180_000 }, async () => {
	const out = mkdtempSync(join(tmpdir(), "sfactory-exp-"));
	const { faux, mode } = scriptedModel();
	const memory = join(out, "memory");
	mode.memory = memory;
	const [first, second, third] = ticketsTask.episodes();
	const run = (phase: keyof typeof PHASES, episode: typeof first, seq: number) => runTrial(options(out, faux), ARMS.D, PHASES[phase], episode, memory, seq);

	mode.value = "cold";
	const a = await run("train", first, 1);
	assert.equal(a.record.memoryAfter.length, 0);
	assert.equal(new TraceStore(join(memory, ".pi", "traces")).list().length, 1);

	mode.value = "cold+save";
	const b = await run("train", second, 2);
	assert.equal(b.record.metrics.workflow.hints, 1, "the repeated request was recognized");
	assert.deepEqual([b.record.metrics.workflow.saveCalls, b.record.metrics.workflow.saved, b.record.metrics.workflow.refused], [1, 1, 0]);
	assert.deepEqual(b.record.metrics.workflow.acquired, ["triage@v1"]);
	assert.equal(b.record.metrics.large.replay.calls, 32, "replay asked for two judgments per ticket of both examples");
	assert.equal(b.record.metrics.large.agent.calls, 5);
	assert.equal(b.record.metrics.large.compile.calls, 1, "one agent turn went into saving");
	assert.equal(b.record.metrics.large.total.calls, 37, "calls outside the agent loop are part of the total");
	assert.deepEqual(b.record.memoryAfter, [{ name: "triage", version: 1, status: "candidate" }]);

	mode.value = "workflow";
	const before = readdirSync(join(memory, ".pi", "workflows", "triage", "fixtures")).length;
	const frozen = await run("test", third, 3);
	assert.equal(frozen.record.reused, true);
	assert.equal(frozen.record.metrics.large.agent.calls, 2);
	assert.equal(frozen.record.metrics.large.decide.calls, 16);
	assert.equal(frozen.record.metrics.decisionModel.llmOnly, 16, "arm D never consults a decision model");
	assert.equal(frozen.record.metrics.decisionModel.total.calls, 0);
	assert.equal(frozen.record.metrics.workflow.runs[0].status, "ok");
	assert.equal(frozen.record.verdict.sideEffects.writes, 8);
	assert.equal(readdirSync(join(memory, ".pi", "workflows", "triage", "fixtures")).length, before, "a frozen trial adds no fixture");
	assert.deepEqual(frozen.record.memoryAfter, [{ name: "triage", version: 1, status: "candidate" }], "and promotes nothing");
	assert.equal(new TraceStore(join(memory, ".pi", "traces")).list().length, 2, "and records no trace");

	const learning = await run("test-online", third, 4);
	assert.equal(learning.record.memoryAfter[0].status, "probation", "the same trial with learning on does update memory");

	const distractor = ticketsTask.episodes().find((e) => e.id === "tickets/adapt-close-product")!;
	const wrong = await run("adapt", distractor, 5);
	assert.equal(wrong.record.misapplied, true);
	assert.equal(wrong.record.verdict.success, false);
	assert.ok(wrong.record.verdict.sideEffects.forbidden > 0, "running the triage workflow on another task changes tickets it must not touch");
});

test("a suite resumes and reports", { timeout: 180_000 }, async () => {
	const out = mkdtempSync(join(tmpdir(), "sfactory-exp-"));
	const { faux, mode } = scriptedModel();
	mode.value = "cold";
	const lines: string[] = [];
	const suite = options(out, faux, { arms: [ARMS.A, ARMS.B], phases: [PHASES.train, PHASES.test], limit: 1, log: (line) => lines.push(line) });
	const records = await runSuite(suite);
	assert.equal(records.length, 4);
	const calls = faux.state.callCount;
	await runSuite(suite);
	assert.equal(faux.state.callCount, calls, "finished trials are not run again");
	assert.equal(loadRecords(out).length, 4);
	const { cells, cumulative } = summarize(loadRecords(out));
	assert.equal(cells.length, 4);
	assert.equal(cells[0].meanLargeCalls, 4);
	assert.equal(cumulative[0].points.length, 2);
	assert.match(renderMarkdown(loadRecords(out)), /\| A \| train \| 1 \| 0% \|/);
});
