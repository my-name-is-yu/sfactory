/**
 * Experiment CLI.
 *
 *   npm run exp -- doctor                      check credentials and models, with one real call each
 *   npm run exp -- list  [--task tickets]      show the episodes (never the gold)
 *   npm run exp -- run   [options]             run trials; resumes an interrupted run
 *   npm run exp -- report --out <dir>          rebuild report.md and summary.json
 *   npm run exp -- inspect --out <dir> --arm E --trial 2    print what happened in one trial
 *   npm run exp -- replay  --out <dir> --arm E [--attempt n] [--model p/id]
 *                                              run the save gate again on a recorded workflow_save call
 *
 * Options for run:
 *   --task tickets|ci          default tickets
 *   --arms A,B,C,D,E           default all five
 *   --phases train,calib,test,adapt[,test-online,adapt-online]
 *   --model provider/id        default openai/gpt-6.1-terra
 *   --classifier provider/id   default openai/gpt-6-luna
 *   --thinking level           default low
 *   --out dir                  default runs/<task>-<timestamp>
 *   --limit n                  only the first n episodes of each phase
 *   --episodes a,b             only episodes whose id ends with one of these, e.g. train-2
 *   --repeat n                 repeat index; each repeat has its own memory (default 0)
 *   --timeout seconds          per trial (default 900)
 *   --min-samples n            shadow samples before a decision site may be promoted (default 20)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildAskPrompt, buildDecidePrompt, ASK_SYSTEM, DECIDE_SYSTEM, parseAsk, parseDecide } from "../extensions/sfactory/src/decide.ts";
import { replayFixture } from "../extensions/sfactory/src/replay.ts";
import { EscalateError, type Fixture } from "../extensions/sfactory/src/types.ts";
import { writeReport } from "./lib/report.ts";
import { ARMS, PHASES, runSuite } from "./lib/runner.ts";
import type { Task } from "./lib/types.ts";
import { ciTask } from "./tasks/ci/task.ts";
import { ticketsTask } from "./tasks/tickets/task.ts";

const TASKS: Record<string, Task> = { tickets: ticketsTask, ci: ciTask };
// Both run on the OpenAI API with one key, OPENAI_API_KEY.
const DEFAULT_MODEL = "openai/gpt-6.1-terra";
const DEFAULT_CLASSIFIER = "openai/gpt-6-luna";

function parse(argv: string[]) {
	const [command = "help", ...rest] = argv;
	const flags: Record<string, string> = {};
	for (let i = 0; i < rest.length; i++) {
		if (!rest[i].startsWith("--")) continue;
		const key = rest[i].slice(2);
		flags[key] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
	}
	return { command, flags };
}

const split = (spec: string) => {
	const at = spec.indexOf("/");
	if (at < 1) throw new Error(`expected provider/id, got "${spec}"`);
	return [spec.slice(0, at), spec.slice(at + 1)] as const;
};

async function doctor(flags: Record<string, string>): Promise<boolean> {
	const runtime = await ModelRuntime.create();
	const modelSpec = flags.model ?? DEFAULT_MODEL;
	const classifierSpec = flags.classifier ?? DEFAULT_CLASSIFIER;
	let ok = true;
	const report = (good: boolean, line: string, hint?: string) => {
		console.log(`${good ? "ok  " : "FAIL"} ${line}`);
		if (!good && hint) console.log(`     ${hint}`);
		ok &&= good;
	};

	const [provider, id] = split(modelSpec);
	const model = runtime.getModel(provider, id);
	report(Boolean(model), `chat model ${modelSpec} is in the catalog`, `Known ${provider} models: ${(await runtime.getAvailable(provider)).map((m) => m.id).join(", ") || "none available"}`);
	const available = (await runtime.getAvailable(provider)).some((m) => m.id === id);
	report(available, `credentials for ${provider}`, provider === "openai" ? "Set OPENAI_API_KEY. If the openai provider is logged in through OAuth, log it out first: npx pi auth logout openai" : `Run: npx pi auth login ${provider}, or set its API key`);
	if (model && available) {
		try {
			const t0 = Date.now();
			const message = await runtime.complete(model as never, { messages: [{ role: "user", content: "Reply with the single word: ready", timestamp: Date.now() }] });
			const text = (message.content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");
			report(message.stopReason !== "error", `chat call: "${text.trim().slice(0, 40)}" in ${Date.now() - t0} ms, ${message.usage.input}+${message.usage.output} tokens`, message.errorMessage);
		} catch (error) {
			report(false, "chat call", String(error));
		}
	}

	const [cProvider, cId] = split(classifierSpec);
	const classifiers = await runtime.getAvailableOfType("classifier");
	const classifier = classifiers.find((m) => m.provider === cProvider && m.id === cId);
	report(
		Boolean(classifier),
		`decision model ${classifierSpec} is available`,
		cProvider === "openai"
			? "The Decisions API needs OPENAI_API_KEY, and the openai provider must not be logged in through OAuth (npx pi auth logout openai)."
			: `Available decision models: ${classifiers.map((m) => `${m.provider}/${m.id}`).join(", ") || "none"}`,
	);
	if (classifier) {
		try {
			const t0 = Date.now();
			const result = await runtime.classify(classifier as never, {
				state: { message: "The app crashes every time I open it." },
				questions: { broken: { type: "bool", instructions: "Does the message report a defect?", criteria: { true: "A defect", false: "Not a defect" } } },
			});
			report(result.stopReason === "stop", `decision call: ${JSON.stringify(result.answers.broken)} in ${Date.now() - t0} ms`, result.errorMessage);
		} catch (error) {
			report(false, "decision call", String(error));
		}
	}
	console.log(ok ? "\nReady. Arms A, B and D need only the chat model; C and E also need the decision model." : "\nNot ready. Arms A, B and D need only the chat model.");
	return ok;
}

/** Print one trial: what the agent said and called, what the tools answered, and what sfactory did. */
function inspect(flags: Record<string, string>) {
	const dir = join(resolve(flags.out), `rep${flags.repeat ?? 0}`, flags.arm ?? "E", "trials");
	const prefix = String(flags.trial ?? 1).padStart(3, "0");
	const file = readdirSync(dir).find((name) => name.startsWith(`${prefix}-`) && name.endsWith(".json") && !name.includes("transcript"));
	if (!file) throw new Error(`no trial ${prefix} in ${dir}`);
	const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
	const v = record.verdict;
	console.log(`${record.arm} #${record.seq} ${record.phase} ${record.episode} (${record.kind}) — ${record.outcome}, ${v.success ? "PASS" : "FAIL"} ${v.correct}/${v.items}, ${(record.wallMs / 1000).toFixed(1)}s`);
	console.log(`memory before: ${JSON.stringify(record.memoryBefore)}  after: ${JSON.stringify(record.memoryAfter)}`);
	if (v.errors.length) console.log(`verifier:\n  ${v.errors.join("\n  ")}`);
	console.log(`side effects: ${JSON.stringify(v.sideEffects)}\n`);
	const clip = (text: unknown, max: number) => {
		const s = typeof text === "string" ? text : JSON.stringify(text);
		return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
	};
	const full = flags.full === "true";
	for (const line of readFileSync(join(dir, file.replace(/\.json$/, ".transcript.jsonl")), "utf8").split("\n").filter(Boolean)) {
		const event = JSON.parse(line);
		if (event.type === "assistant") {
			if (event.text) console.log(`ASSISTANT  ${event.text}`);
			for (const call of event.calls ?? []) {
				const code = call.args?.code;
				if (typeof code === "string") console.log(`  -> ${call.name}  ${clip({ ...call.args, code: undefined }, 600)}\n${(full ? code : clip(code, 1500)).replace(/^/gm, "       ")}`);
				else console.log(`  -> ${call.name}  ${clip(call.args, full ? 1e6 : 400)}`);
			}
		} else if (event.type === "tool") {
			console.log(`  <- ${event.name}${event.error ? " ERROR" : ""}  ${clip(event.result, full ? 1e6 : 700).replace(/\n/g, "\n       ")}`);
		} else if (event.type === "sfactory" && event.role === undefined) {
			console.log(`  ** sfactory ${clip({ ...event, type: undefined }, 400)}`);
		}
	}
}

/** Run the admission gate again on what a workflow_save call submitted, asking the model for the judgments. */
async function replay(flags: Record<string, string>) {
	const dir = join(resolve(flags.out), `rep${flags.repeat ?? 0}`, flags.arm ?? "E", "memory", ".pi", "workflows", "_attempts");
	const files = existsSync(dir) ? readdirSync(dir).sort() : [];
	if (!files.length) throw new Error(`no recorded workflow_save calls in ${dir}`);
	const index = flags.attempt ? Number(flags.attempt) - 1 : files.length - 1;
	const attempt = JSON.parse(readFileSync(join(dir, files[index]), "utf8"));
	console.log(`attempt ${index + 1} of ${files.length}: ${attempt.name}, originally ${attempt.outcome}`);
	for (const report of attempt.reports) console.log(`  then: ${String(report.summary).replace(/\n/g, "\n        ")}`);

	const runtime = await ModelRuntime.create();
	const [provider, id] = split(flags.model ?? DEFAULT_MODEL);
	const model = runtime.getModel(provider, id);
	if (!model) throw new Error(`model ${provider}/${id} is not in the catalog`);
	let calls = 0;
	const chat = async (system: string, prompt: string) => {
		calls++;
		const message = await runtime.complete(model as never, { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] });
		if (message.stopReason === "error") throw new Error(message.errorMessage ?? "model call failed");
		return (message.content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");
	};
	for (const fixture of attempt.fixtures as Fixture[]) {
		const report = await replayFixture(attempt.code, fixture, attempt.tools, {
			async decide(question) {
				const answer = parseDecide(question, await chat(DECIDE_SYSTEM, buildDecidePrompt(question)));
				if (answer === "none") throw new EscalateError("none of the options fit");
				return { answer, by: "s2", confidence: 1 };
			},
			ask: async (prompt, state, schema) => parseAsk(await chat(ASK_SYSTEM, buildAskPrompt(prompt, state, schema)), schema),
		});
		console.log(`  now:  ${report.summary.replace(/\n/g, "\n        ")}`);
	}
	console.log(`${calls} model calls`);
}

async function main() {
	const { command, flags } = parse(process.argv.slice(2));
	const task = TASKS[flags.task ?? "tickets"];
	if (!task) throw new Error(`unknown task ${flags.task}; choose from ${Object.keys(TASKS).join(", ")}`);

	if (command === "doctor") {
		process.exitCode = (await doctor(flags)) ? 0 : 1;
		return;
	}
	if (command === "list") {
		for (const episode of task.episodes()) console.log(`${episode.id.padEnd(30)} ${episode.split.padEnd(6)} ${episode.kind.padEnd(11)} reuse=${episode.reuse}`);
		return;
	}
	if (command === "inspect" || command === "replay") {
		if (!flags.out) throw new Error(`${command} needs --out <dir>`);
		if (command === "inspect") inspect(flags);
		else await replay(flags);
		return;
	}
	if (command === "report") {
		if (!flags.out) throw new Error("report needs --out <dir>");
		console.log(writeReport(resolve(flags.out)));
		return;
	}
	if (command !== "run") {
		console.log("usage: npm run exp -- doctor | list | run | report | inspect | replay   (see the header of experiments/run.ts)");
		return;
	}

	const pick = <T>(names: string, table: Record<string, T>, what: string) =>
		names.split(",").map((name) => {
			const hit = table[name.trim()];
			if (!hit) throw new Error(`unknown ${what} "${name}"; choose from ${Object.keys(table).join(", ")}`);
			return hit;
		});
	const arms = pick(flags.arms ?? "A,B,C,D,E", ARMS, "arm");
	const phases = pick(flags.phases ?? "train,calib,test,adapt", PHASES, "phase");
	const runtime = await ModelRuntime.create();
	const [provider, id] = split(flags.model ?? DEFAULT_MODEL);
	const model = runtime.getModel(provider, id);
	if (!model) throw new Error(`model ${provider}/${id} is not in the catalog; run "npm run exp -- doctor"`);
	const out = resolve(flags.out ?? join("runs", `${task.name}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}`));

	console.log(`task ${task.name} | arms ${arms.map((a) => a.id).join(",")} | phases ${phases.map((p) => p.name).join(",")} | model ${provider}/${id} | out ${out}`);
	await runSuite({
		task,
		arms,
		phases,
		model,
		modelRuntime: runtime,
		classifier: flags.classifier ?? DEFAULT_CLASSIFIER,
		thinking: flags.thinking ?? "low",
		outDir: out,
		limit: flags.limit ? Number(flags.limit) : undefined,
		episodes: flags.episodes ? flags.episodes.split(",").map((name) => name.trim()) : undefined,
		repeat: flags.repeat ? Number(flags.repeat) : 0,
		timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
		minSamples: flags["min-samples"] ? Number(flags["min-samples"]) : undefined,
		log: (line) => console.log(line),
	});
	writeReport(out);
	console.log(`\nreport: ${join(out, "report.md")}`);
}

main()
	.catch((error) => {
		console.error(error instanceof Error ? (error.stack ?? error.message) : error);
		process.exitCode = 1;
	})
	// Sandbox workers and provider connections may linger; the run is over.
	.finally(() => process.exit());
