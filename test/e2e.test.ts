/**
 * End to end through a real Pi agent session, with a scripted model instead of a provider:
 * two cold runs, compilation through the replay gate, a warm run, an escalation, and the guards.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import tickets from "../demo/tickets.ts";
import { seed, type Ticket, World } from "../demo/world.ts";
import sfactory from "../extensions/sfactory/index.ts";
import { TraceStore, WorkflowStore } from "../extensions/sfactory/src/store.ts";

/** How the scripted model judges a ticket, both when it works by hand and when a workflow asks it. */
function judge(ticket: Pick<Ticket, "subject" | "body">): { label: string | null; urgent: boolean } {
	const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
	const label = /gdpr|partnership/.test(text)
		? null
		: /charge|refund|invoice/.test(text)
		? "billing"
		: /crash|losing|returns no|not arriving/.test(text)
			? "bug"
			: /log in|email|sign in/.test(text)
				? "account"
				: /add|would|shortcut/.test(text)
					? "feature_request"
					: null;
	return { label, urgent: /urgent|locked out|today|all of our team|an hour/.test(text) };
}

const WORKFLOW = `const { tickets } = await tools.tickets_list({ status: input.status });
const full = await Promise.all(tickets.map((t) => tools.tickets_get({ id: t.id })));
const done = [];
for (const t of full) {
  const state = { subject: t.subject, body: t.body };
  const category = await decide({ id: "category", state, type: "choice",
    instructions: "Which team should handle this support ticket?",
    criteria: { billing: "Charges, refunds, invoices", bug: "Something is broken", account: "Login and account settings", feature_request: "A suggestion" } });
  const urgent = await decide({ id: "urgent", state, type: "bool",
    instructions: "Does the customer need help today?", criteria: { true: "Blocked or losing data", false: "Can wait" } });
  const updated = await tools.tickets_update({ id: t.id, label: category.answer, priority: urgent.answer ? "urgent" : "normal", status: "triaged" });
  if (updated.label !== category.answer) throw new Error("label was not applied to " + t.id);
  done.push({ id: t.id, label: updated.label, priority: updated.priority });
}
const left = await tools.tickets_list({ status: input.status });
if (left.tickets.length) throw new Error(left.tickets.length + " tickets are still " + input.status);
return { triaged: done };`;

test("experience becomes a workflow, and the workflow knows its limits", { timeout: 120_000 }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "sfactory-e2e-"));
	const world = new World(cwd);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });

	// Agent turns come from `plan`. Judgments asked by decide() are answered in place.
	const plan: ((...args: never[]) => AssistantMessage)[] = [];
	let judgments = 0;
	const respond = (context: { messages: { role: string; content: unknown }[] }): AssistantMessage => {
		const last = context.messages.at(-1);
		const text = typeof last?.content === "string" ? last.content : "";
		if (last?.role === "user" && text.includes('Reply {"answer"')) {
			judgments++;
			const state = JSON.parse(text.slice(text.lastIndexOf("State:") + 6)) as Ticket;
			const verdict = judge(state);
			return fauxAssistantMessage(JSON.stringify({ answer: text.includes('Reply {"answer": true}') ? verdict.urgent : verdict.label }));
		}
		const next = plan.shift();
		if (!next) throw new Error("the scripted model has no reply left");
		return next();
	};
	faux.setResponses(Array.from({ length: 500 }, () => respond as never));

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, ".agent"),
		extensionFactories: [(pi: ExtensionAPI) => pi.registerProvider(faux.provider), sfactory, tickets],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: join(cwd, ".agent"), resourceLoader, sessionManager: SessionManager.inMemory(), model: faux.getModel() });
	await session.bindExtensions({});

	const results: { tool: string; text: string; isError: boolean }[] = [];
	const hints: string[] = [];
	session.subscribe((event: any) => {
		if (event.type === "tool_execution_end" && !String(event.toolCallId).includes("/")) {
			results.push({ tool: event.toolName, text: (event.result?.content ?? []).map((c: any) => c.text ?? "").join("\n"), isError: event.isError });
		}
		if (event.type === "message_end" && event.message?.customType === "sfactory-hint") hints.push(String(event.message.content));
	});
	const calls = (...list: ReturnType<typeof fauxToolCall>[]) => () => fauxAssistantMessage(list, { stopReason: "toolUse" });
	const say = (text: string) => () => fauxAssistantMessage([fauxText(text)]);

	/** The model working by hand: list, read each ticket, label each, check nothing is left. */
	const coldRun = async (batch: number) => {
		const batchTickets = world.reset(batch);
		plan.push(
			calls(fauxToolCall("tickets_list", { status: "open" })),
			calls(...batchTickets.map((t) => fauxToolCall("tickets_get", { id: t.id }))),
			calls(
				...batchTickets.map((t) => {
					const verdict = judge(t);
					return fauxToolCall("tickets_update", { id: t.id, label: verdict.label, priority: verdict.urgent ? "urgent" : "normal", status: "triaged" });
				}),
			),
			calls(fauxToolCall("tickets_list", { status: "open" })),
			say("All open tickets are triaged."),
		);
		await session.prompt(`Triage the open support tickets of batch ${batch}: label each and set its priority.`);
	};

	try {
		const active = session.getActiveToolNames();
		for (const name of ["workflow_trace", "workflow_save", "workflow_feedback", "tickets_list"]) assert.ok(active.includes(name), `${name} is active`);

		// --- Two cold runs. The second one is recognized as a repeat. ---
		await coldRun(1);
		assert.ok(world.read().every((t) => t.status === "triaged"));
		assert.equal(hints.length, 0);
		await coldRun(2);
		assert.equal(hints.length, 1, "the second run is flagged as resembling the first");

		const traces = new TraceStore(join(cwd, ".pi", "traces")).list();
		assert.equal(traces.length, 2);
		assert.equal(traces[0].calls.length, 14);
		assert.equal(traces[0].calls.filter((c) => !c.readOnly).length, 6);
		assert.equal(traces[0].turns, 5);
		const [second, first] = traces.map((t) => t.id);

		// --- Compilation. A program that skips a recorded effect is refused. ---
		const example = (trace: string) => ({ trace, input: { status: "open" } });
		const save = (code: string) =>
			fauxToolCall("workflow_save", {
				name: "triage_tickets",
				description: "Triage support tickets with a given status: label each by team and set its priority. Not for replying to tickets.",
				input_schema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
				code,
				examples: [example(first), example(second)],
			});
		plan.push(calls(fauxToolCall("workflow_trace", { id: first })), calls(save(WORKFLOW.replace('status: "triaged"', 'status: "closed"'))), say("That failed."));
		await session.prompt("Make ticket triage reusable.");
		const refused = results.at(-1)!;
		assert.equal(refused.tool, "workflow_save");
		assert.equal(refused.isError, true);
		assert.match(refused.text, /NOT SAVED/);
		assert.match(refused.text, /never observed/);
		assert.equal(new WorkflowStore(join(cwd, ".pi", "workflows")).list().length, 0);

		const judgedBeforeSave = judgments;
		plan.push(calls(save(WORKFLOW)), say("Saved."));
		await session.prompt("Try again.");
		const saved = results.at(-1)!;
		assert.equal(saved.isError, false, saved.text);
		assert.match(saved.text, /Saved triage_tickets v1 as tool wf_triage_tickets \[candidate\]/);
		assert.equal(judgments - judgedBeforeSave, 16, "replay asked the model once for each distinct judgment of both examples");
		assert.ok(world.read().every((t) => t.id.startsWith("T-2")), "replay did not touch the world");
		assert.ok(session.getActiveToolNames().includes("wf_triage_tickets"));

		// --- Warm run on unseen tickets: one model turn to start it, one to report. ---
		world.reset(4);
		const turnsBefore = faux.state.callCount;
		const judgedBeforeWarm = judgments;
		plan.push(calls(fauxToolCall("wf_triage_tickets", { status: "open" })), say("Triaged batch 4."));
		await session.prompt("Triage the open support tickets of batch 4: label each and set its priority.");
		const warm = results.at(-1)!;
		assert.equal(warm.isError, false, warm.text);
		assert.match(warm.text, /ok in \d+ ms: 14 tool calls, 12 judgments/);
		for (const t of world.read()) {
			const verdict = judge(t);
			assert.deepEqual([t.status, t.label, t.priority], ["triaged", verdict.label, verdict.urgent ? "urgent" : "normal"], t.id);
		}
		assert.equal(faux.state.callCount - turnsBefore - (judgments - judgedBeforeWarm), 2, "two agent turns instead of five");
		const store = new WorkflowStore(join(cwd, ".pi", "workflows"));
		assert.equal(store.load("triage_tickets")!.meta.status, "probation");
		assert.equal(store.fixtures("triage_tickets").length, 3, "the warm run became a regression fixture");

		// --- An input the runs never covered: the workflow stops and reports what it already did. ---
		world.reset(3);
		plan.push(calls(fauxToolCall("wf_triage_tickets", { status: "open" })), say("One ticket needs a human."));
		await session.prompt("Triage the open support tickets of batch 3.");
		const escalated = results.at(-1)!;
		assert.match(escalated.text, /escalated/);
		assert.match(escalated.text, /none of the options fit/);
		assert.match(escalated.text, /Side effects already applied \(do NOT repeat them\)/);
		assert.equal((escalated.text.match(/- tickets_update\(/g) ?? []).length, 5);
		assert.deepEqual(world.read().map((t) => t.status), ["triaged", "triaged", "triaged", "triaged", "triaged", "open"]);
		assert.equal(store.load("triage_tickets")!.meta.stats.escalated, 1);
		assert.equal(store.load("triage_tickets")!.meta.status, "probation", "declining an uncovered input is not a defect");

		// --- Guards: the store cannot be written around the gate, and an edited workflow will not run. ---
		const file = join(cwd, ".pi", "workflows", "triage_tickets", "workflow.js");
		plan.push(calls(fauxToolCall("write", { path: ".pi/workflows/triage_tickets/workflow.js", content: "return 1;" })), say("Blocked."));
		await session.prompt("Overwrite the workflow file.");
		assert.equal(results.at(-1)!.isError, true);
		assert.match(results.at(-1)!.text, /managed by sfactory/);
		assert.equal(readFileSync(file, "utf8"), WORKFLOW);

		writeFileSync(file, `${WORKFLOW}\n// edited by hand`);
		world.reset(5);
		plan.push(calls(fauxToolCall("wf_triage_tickets", { status: "open" })), say("It refused."));
		await session.prompt("Triage batch 5.");
		assert.equal(results.at(-1)!.isError, true);
		assert.match(results.at(-1)!.text, /modified outside workflow_save/);
		assert.ok(world.read().every((t) => t.status === "open"));
	} finally {
		session.dispose();
	}
});

test("a cold run done through codemode is recorded call by call", { timeout: 60_000 }, async () => {
	const { createCodemodeExtension, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const cwd = mkdtempSync(join(tmpdir(), "sfactory-e2e-"));
	const world = new World(cwd);
	world.reset(1);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted" }] });
	const script = `const { tickets } = await tools.tickets_list({ status: "open" });
const first = await tools.tickets_get({ id: tickets[0].id });
await tools.tickets_update({ id: first.id, label: "billing", status: "triaged" });
return first.subject;`;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("codemode", { code: script })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, ".agent"),
		extensionFactories: [(pi: ExtensionAPI) => pi.registerProvider(faux.provider), createCodemodeExtension({ mode: "on" }), sfactory, tickets],
	});
	await resourceLoader.reload();
	const settingsManager = SettingsManager.create(cwd, join(cwd, ".agent"));
	settingsManager.applyOverrides({ defaultTools: ["+codemode"] });
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, ".agent"),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		model: faux.getModel(),
	});
	await session.bindExtensions({});
	try {
		assert.ok(session.getActiveToolNames().includes("codemode"));
		await session.prompt("Label the first open ticket.");
		const [trace] = new TraceStore(join(cwd, ".pi", "traces")).list();
		assert.deepEqual(trace.calls.map((c) => [c.tool, c.readOnly, c.ok]), [
			["tickets_list", true, true],
			["tickets_get", true, true],
			["tickets_update", false, true],
		]);
		assert.equal((trace.calls[1].value as Ticket).id, "T-101", "results are recorded as the script saw them");
		assert.equal(world.read()[0].label, "billing");
	} finally {
		session.dispose();
	}
});
