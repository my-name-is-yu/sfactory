import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { calibrate, type CascadeDeps, DEFAULT_CASCADE, decideCascade, extractJson, parseDecide } from "../extensions/sfactory/src/decide.ts";
import { type Host, runWorkflow, type ToolDecl } from "../extensions/sfactory/src/engine.ts";
import { replayFixture } from "../extensions/sfactory/src/replay.ts";
import { hashTools, sha256, similarity, WorkflowStore } from "../extensions/sfactory/src/store.ts";
import { type DecideQuestion, EscalateError, type Fixture, type WorkflowMeta } from "../extensions/sfactory/src/types.ts";

const TOOLS: ToolDecl[] = [
	{ name: "items_list", readOnly: true },
	{ name: "items_label", readOnly: false },
];

function fakeHost(overrides: Partial<Host> = {}): Host & { labels: Record<string, string> } {
	const labels: Record<string, string> = {};
	return {
		labels,
		async callTool(name, args) {
			const a = args as { id?: string; label?: string };
			if (name === "items_list") return [{ id: "a", text: "refund please" }, { id: "b", text: "love it" }];
			if (name === "items_label") {
				if (a.id === "boom") throw new Error("no such item");
				labels[a.id!] = a.label!;
				return { ok: true };
			}
			throw new Error(`unknown tool ${name}`);
		},
		async decide(q) {
			return { answer: String(q.state.text).includes("refund") ? "billing" : "praise", by: "s2", confidence: 1 };
		},
		async ask(prompt) {
			return { text: `re: ${prompt}` };
		},
		...overrides,
	};
}

const TRIAGE = `
const items = await tools.items_list({});
for (const item of items) {
  const d = await decide({ id: "kind", state: { text: item.text }, type: "choice",
    instructions: "What is this about?", criteria: { billing: "money", praise: "happy" } });
  await tools.items_label({ id: item.id, label: d.answer });
}
return { labelled: items.length, prefix: input.prefix };
`;

test("runs a workflow with input, tools and decide", async () => {
	const host = fakeHost();
	const result = await runWorkflow({ code: TRIAGE, input: { prefix: "x" }, tools: TOOLS, host });
	assert.equal(result.status, "ok", result.reason);
	assert.deepEqual(result.value, { labelled: 2, prefix: "x" });
	assert.deepEqual(host.labels, { a: "billing", b: "praise" });
	assert.equal(result.calls.length, 3);
	assert.equal(result.decisions.length, 2);
});

test("only the allowed tools exist in the sandbox", async () => {
	const result = await runWorkflow({
		code: "return [Object.keys(tools), typeof fetch, typeof require, typeof process];",
		input: null,
		tools: [TOOLS[0]],
		host: fakeHost(),
	});
	assert.deepEqual(result.value, [["items_list"], "undefined", "undefined", "undefined"]);
	const denied = await runWorkflow({ code: "await tools.items_label({});", input: null, tools: [TOOLS[0]], host: fakeHost() });
	assert.equal(denied.status, "failed");
	assert.match(denied.reason!, /does not exist/);
});

test("escalate ends the run even inside try/catch and hands over state", async () => {
	const host = fakeHost();
	const result = await runWorkflow({
		code: `await tools.items_label({ id: "a", label: "x" });
try { await escalate("unknown category", { id: "b" }); } catch (e) {}
await tools.items_label({ id: "b", label: "y" });
return "done";`,
		input: null,
		tools: TOOLS,
		host,
	});
	assert.equal(result.status, "escalated");
	assert.equal(result.reason, "unknown category");
	assert.deepEqual(result.state, { id: "b" });
	assert.deepEqual(host.labels, { a: "x" });
});

test("a host escalation from decide ends the run", async () => {
	const host = fakeHost({
		async decide() {
			throw new EscalateError("none of the options fit", { why: "new" });
		},
	});
	const result = await runWorkflow({ code: TRIAGE, input: {}, tools: TOOLS, host });
	assert.equal(result.status, "escalated");
	assert.deepEqual(host.labels, {});
});

test("tool errors are ordinary errors a script may handle", async () => {
	const result = await runWorkflow({
		code: `try { await tools.items_label({ id: "boom", label: "x" }); } catch (e) { return "caught: " + e.message; }`,
		input: null,
		tools: TOOLS,
		host: fakeHost(),
	});
	assert.equal(result.status, "ok");
	assert.equal(result.value, "caught: no such item");
	assert.equal(result.calls[0].ok, false);
});

test("script errors, call budgets and loops end the run as failed", async () => {
	const thrown = await runWorkflow({ code: "null.x;", input: null, tools: TOOLS, host: fakeHost() });
	assert.equal(thrown.status, "failed");

	const greedy = await runWorkflow({
		code: `while (true) { try { await tools.items_list({}); } catch (e) {} }`,
		input: null,
		tools: TOOLS,
		host: fakeHost(),
		budget: { maxCalls: 5 },
	});
	assert.equal(greedy.status, "failed");
	assert.match(greedy.reason!, /budget exceeded/);
	assert.equal(greedy.calls.length, 5);

	const spin = await runWorkflow({ code: "while (true) {}", input: null, tools: TOOLS, host: fakeHost(), budget: { timeoutMs: 300 } });
	assert.equal(spin.status, "failed");
	assert.match(spin.reason!, /timeout/);
});

function fixtureFrom(result: Awaited<ReturnType<typeof runWorkflow>>, input: unknown): Fixture {
	return { id: "t-1", source: "trace", input, ignore: [], calls: result.calls, decisions: [] };
}

test("replay admits a workflow that reproduces the recorded side effects", async () => {
	const recorded = await runWorkflow({ code: TRIAGE, input: { prefix: "x" }, tools: TOOLS, host: fakeHost() });
	const live = fakeHost({
		async callTool() {
			throw new Error("replay must not touch the world");
		},
	});
	const report = await replayFixture(TRIAGE, fixtureFrom(recorded, { prefix: "x" }), TOOLS, live);
	assert.equal(report.pass, true, report.summary);
});

test("replay rejects unobserved calls, missing side effects and repeated side effects", async () => {
	const recorded = await runWorkflow({ code: TRIAGE, input: {}, tools: TOOLS, host: fakeHost() });
	const fixture = fixtureFrom(recorded, {});
	const live = fakeHost();

	const wrongArgs = await replayFixture(`await tools.items_label({ id: "zzz", label: "billing" });`, fixture, TOOLS, live);
	assert.equal(wrongArgs.pass, false);
	assert.match(wrongArgs.summary, /never observed/);

	const lazy = await replayFixture(`await tools.items_list({}); return 1;`, fixture, TOOLS, live);
	assert.equal(lazy.pass, false);
	assert.equal(lazy.missing.length, 2);

	const twice = await replayFixture(
		`${TRIAGE.replace("return {", "await tools.items_label({ id: 'a', label: 'billing' }); return {")}`,
		fixture,
		TOOLS,
		live,
	);
	assert.equal(twice.pass, false);

	const ignoring = await replayFixture(`await tools.items_list({}); return 1;`, { ...fixture, ignore: fixture.calls.map((c) => c.seq) }, TOOLS, live);
	assert.equal(ignoring.pass, true);
});

test("replay catches a judgment that no longer leads to the demonstrated outcome", async () => {
	const recorded = await runWorkflow({ code: TRIAGE, input: {}, tools: TOOLS, host: fakeHost() });
	const drifted = fakeHost({
		async decide() {
			return { answer: "praise", by: "s2", confidence: 1 };
		},
	});
	const report = await replayFixture(TRIAGE, fixtureFrom(recorded, {}), TOOLS, drifted);
	assert.equal(report.pass, false);
});

const Q: DecideQuestion = { id: "kind", state: { text: "x" }, type: "choice", instructions: "?", criteria: { a: "A", b: "B" } };

test("a decision site is promoted once the decision model agrees, and audited afterwards", async () => {
	const sites = {};
	let llmCalls = 0;
	let fastCalls = 0;
	const deps: CascadeDeps = {
		config: { ...DEFAULT_CASCADE, minSamples: 5, auditEvery: 4 },
		sites,
		classify: async () => {
			fastCalls++;
			return { answer: "a", confidence: 0.97 };
		},
		llm: async () => {
			llmCalls++;
			return "a";
		},
	};
	const signal = new AbortController().signal;
	for (let i = 0; i < 5; i++) assert.equal((await decideCascade(Q, deps, signal)).by, "s2");
	assert.equal(llmCalls, 5);
	const by: string[] = [];
	for (let i = 0; i < 8; i++) by.push((await decideCascade(Q, deps, signal)).by);
	assert.deepEqual(by, Array(8).fill("s1"));
	assert.equal(llmCalls, 7, "two of eight fast answers are audited");
	assert.equal(fastCalls, 13);
});

test("disagreement keeps a site on the LLM, and demotes a promoted one", async () => {
	const config = { ...DEFAULT_CASCADE, minSamples: 5, auditEvery: 1, window: 10 };
	const signal = new AbortController().signal;
	const never: CascadeDeps = { config, sites: {}, classify: async () => ({ answer: "b", confidence: 0.99 }), llm: async () => "a" };
	for (let i = 0; i < 12; i++) assert.equal((await decideCascade(Q, never, signal)).answer, "a");
	assert.equal(never.sites.kind.tier, "s2");

	let fast = "a";
	const drifting: CascadeDeps = { config, sites: {}, classify: async () => ({ answer: fast, confidence: 0.99 }), llm: async () => "a" };
	for (let i = 0; i < 5; i++) await decideCascade(Q, drifting, signal);
	assert.equal(drifting.sites.kind.tier, "s1");
	fast = "b";
	const answer = await decideCascade(Q, drifting, signal);
	assert.equal(answer.answer, "a", "an audited disagreement is settled by the LLM");
	assert.equal(drifting.sites.kind.tier, "s2");
});

test("low confidence falls back to the LLM, and no fitting option escalates", async () => {
	const signal = new AbortController().signal;
	const config = { ...DEFAULT_CASCADE, minSamples: 4 };
	const site = { tier: "s1" as const, tau: 0.9, samples: [], served: 0 };
	const low: CascadeDeps = { config, sites: { kind: site }, classify: async () => ({ answer: "b", confidence: 0.5 }), llm: async () => "a" };
	assert.deepEqual(await decideCascade(Q, low, signal), { answer: "a", by: "s2", confidence: 1 });

	const none: CascadeDeps = { config: { ...config, mode: "llm" }, sites: {}, llm: async () => "none" };
	await assert.rejects(decideCascade(Q, none, signal), EscalateError);
});

test("calibrate picks the smallest threshold with enough agreement", () => {
	const config = { ...DEFAULT_CASCADE, minSamples: 10, minCoverage: 0.3 };
	const samples: [number, 0 | 1][] = [
		...Array.from({ length: 8 }, () => [0.95, 1] as [number, 0 | 1]),
		[0.7, 0],
		[0.6, 0],
	];
	assert.equal(calibrate(samples, config), 0.95);
	assert.equal(calibrate(samples.slice(0, 5), config), undefined);
	assert.equal(calibrate(samples.map(([c]) => [c, 0] as [number, 0 | 1]), config), undefined);
});

test("parses model replies", () => {
	assert.deepEqual(extractJson('Sure:\n```json\n{"answer": "a"}\n```'), { answer: "a" });
	assert.equal(parseDecide(Q, '{"answer":"b"}'), "b");
	assert.equal(parseDecide(Q, '{"answer":null}'), "none");
	assert.throws(() => parseDecide(Q, '{"answer":"zzz"}'));
	assert.equal(parseDecide({ ...Q, type: "bool", criteria: { true: "y", false: "n" } }, '{"answer": false}'), false);
});

test("the store keeps versions and detects edits made behind its back", () => {
	const store = new WorkflowStore(mkdtempSync(join(tmpdir(), "sfactory-")));
	const meta: WorkflowMeta = {
		name: "triage",
		description: "d",
		inputSchema: { type: "object" },
		tools: ["items_list"],
		toolsHash: hashTools([{ name: "items_list", parameters: {} }]),
		sha256: sha256("return 1;"),
		version: 1,
		status: "candidate",
		createdAt: "",
		updatedAt: "",
		stats: { runs: 0, ok: 0, failed: 0, escalated: 0, consecutiveOk: 0 },
		sites: {},
		notes: [],
	};
	const fixture: Fixture = { id: "t-1", source: "trace", input: {}, ignore: [], calls: [], decisions: [] };
	store.save(meta, "return 1;", [fixture]);
	assert.equal(store.load("triage")!.intact, true);
	assert.equal(store.fixtures("triage").length, 1);

	store.save({ ...meta, version: 2, sha256: sha256("return 2;") }, "return 2;", [fixture]);
	assert.equal(store.load("triage")!.code, "return 2;");
	assert.equal(store.list()[0].version, 2);

	store.save({ ...meta, version: 3, sha256: "stale" }, "return 3;", [fixture]);
	assert.equal(store.load("triage")!.intact, false);
	assert.throws(() => store.load("../etc"));
});

test("similarity recognizes a repeated request, in Japanese too", () => {
	assert.ok(similarity("未処理のチケットをトリアージして", "未処理チケットをトリアージしてください") > 0.5);
	assert.ok(similarity("triage the open tickets in batch 2", "triage the open tickets in batch 3") > 0.7);
	assert.ok(similarity("triage the open tickets", "write a haiku about autumn") < 0.2);
});

// --- judgments that differ from the demonstration ---

const FIVE = ["refund a", "refund b", "refund c", "love d", "love e"].map((text, i) => ({ id: `i${i}`, text }));

async function recordFive() {
	const host = fakeHost({
		async callTool(name, args) {
			return name === "items_list" ? FIVE : { ok: true, args };
		},
	});
	const result = await runWorkflow({ code: TRIAGE, input: {}, tools: TOOLS, host });
	return fixtureFrom(result, {});
}

test("replay finds the demonstrated answer when one live judgment differs, and reports it", async () => {
	const fixture = await recordFive();
	let asked = 0;
	const moody = fakeHost({
		async decide(q) {
			asked++;
			const text = String(q.state.text);
			return { answer: text === "refund b" ? "praise" : text.includes("refund") ? "billing" : "praise", by: "s2", confidence: 1 };
		},
	});
	const report = await replayFixture(TRIAGE, fixture, TOOLS, moody);
	assert.equal(report.pass, true, report.summary);
	assert.deepEqual(report.divergences, [{ site: "kind", state: { text: "refund b" }, live: "praise", demonstrated: "billing" }]);
	assert.match(report.summary, /1 judgment\(s\) differ/);
	assert.equal(asked, 5, "each question is asked once, however often the run is repeated");
});

test("replay infers the answer when the live judgment finds no fitting option", async () => {
	const fixture = await recordFive();
	const unsure = fakeHost({
		async decide(q) {
			if (q.state.text === "love d") throw new EscalateError("none of the options fit");
			return { answer: String(q.state.text).includes("refund") ? "billing" : "praise", by: "s2", confidence: 1 };
		},
	});
	const report = await replayFixture(TRIAGE, fixture, TOOLS, unsure);
	assert.equal(report.pass, true, report.summary);
	assert.deepEqual(report.divergences.map((d) => [d.live, d.demonstrated]), [["none", "praise"]]);
});

test("replay still refuses questions that mostly miss the demonstration, and programs no answer can save", async () => {
	const fixture = await recordFive();
	const contrary = fakeHost({
		async decide(q) {
			return { answer: String(q.state.text).includes("refund") ? "praise" : "billing", by: "s2", confidence: 1 };
		},
	});
	const off = await replayFixture(TRIAGE, fixture, TOOLS, contrary);
	assert.equal(off.pass, false);
	assert.match(off.summary, /5 of 5 judgments differ/);

	const wrongField = await replayFixture(TRIAGE.replace("label: d.answer", "label: d.answer, extra: 1"), fixture, TOOLS, fakeHost());
	assert.equal(wrongField.pass, false);
	assert.match(wrongField.summary, /never observed/);
});

test("the save a real model was refused in the smoke run is now admitted, with the one differing judgment reported", async () => {
	const { readFileSync } = await import("node:fs");
	const smoke = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "smoke-refused.json"), "utf8")) as { code: string; fixtures: Fixture[] };
	const tools: ToolDecl[] = [
		{ name: "tickets_policy", readOnly: true },
		{ name: "tickets_list", readOnly: true },
		{ name: "tickets_get", readOnly: true },
		{ name: "tickets_update", readOnly: false },
	];
	const reports = [];
	for (const fixture of smoke.fixtures) {
		// Stands in for the live model: it answers as the agent did by hand in the recording, except
		// for the one ticket where the live model answered differently in the smoke run.
		const live = fakeHost({
			async decide(q) {
				const ticket = fixture.calls.find((c) => c.tool === "tickets_get" && (c.value as { subject: string }).subject === q.state.subject)!.value as { id: string };
				const update = fixture.calls.find((c) => c.tool === "tickets_update" && (c.args as { id: string }).id === ticket.id)!.args as { label: string; priority?: string };
				if (q.id === "priority" && ticket.id === "TK-2688") return { answer: "low", by: "s2", confidence: 1 };
				return { answer: q.id === "team" ? update.label : update.priority!, by: "s2", confidence: 1 };
			},
		});
		reports.push(await replayFixture(smoke.code, fixture, tools, live));
	}
	assert.deepEqual(reports.map((r) => r.pass), [true, true], reports.map((r) => r.summary).join("\n"));
	assert.equal(reports[0].divergences.length, 0);
	assert.deepEqual(reports[1].divergences.map((d) => [d.site, d.live, d.demonstrated]), [["priority", "low", "normal"]]);
});
