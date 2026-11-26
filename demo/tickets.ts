/**
 * Demo tools: a small support desk. Load next to sfactory to try Workflow Memory on a task that
 * recurs with different data:
 *
 *   /tickets reset 2     replace the desk with batch 2 (all tickets open again)
 *   /tickets             show the desk
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { table, World } from "./world.ts";

const TicketSchema = Type.Object({
	id: Type.String(),
	customer: Type.String(),
	subject: Type.String(),
	body: Type.String(),
	status: Type.String(),
	label: Type.Union([Type.String(), Type.Null()]),
	priority: Type.Union([Type.String(), Type.Null()]),
	draft: Type.Union([Type.String(), Type.Null()]),
});

export default function tickets(pi: ExtensionAPI) {
	const namespace = { name: "tickets", description: "The support desk: list, read, label and answer customer tickets" };
	const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }], details: undefined, structuredContent: value as never });

	pi.registerTool({
		name: "tickets_list",
		label: "List tickets",
		description: "List tickets, optionally only those with a given status (open, triaged, closed). Returns id, subject and status.",
		parameters: Type.Object({ status: Type.Optional(Type.String()) }),
		outputSchema: Type.Object({ tickets: Type.Array(Type.Object({ id: Type.String(), subject: Type.String(), status: Type.String() })) }),
		annotations: { readOnlyHint: true },
		namespace,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const all = new World(ctx.cwd).read();
			const tickets = all.filter((t) => !params.status || t.status === params.status).map(({ id, subject, status }) => ({ id, subject, status }));
			return json({ tickets });
		},
	});

	pi.registerTool({
		name: "tickets_get",
		label: "Get ticket",
		description: "Read one ticket in full, including the customer's message.",
		parameters: Type.Object({ id: Type.String() }),
		outputSchema: TicketSchema,
		annotations: { readOnlyHint: true },
		namespace,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const ticket = new World(ctx.cwd).read().find((t) => t.id === params.id);
			if (!ticket) throw new Error(`no ticket ${params.id}`);
			return json(ticket);
		},
	});

	pi.registerTool({
		name: "tickets_update",
		label: "Update ticket",
		description: "Set a ticket's label, priority (low, normal, urgent) and/or status (open, triaged, closed).",
		parameters: Type.Object({
			id: Type.String(),
			label: Type.Optional(Type.String()),
			priority: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
		}),
		outputSchema: TicketSchema,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		namespace,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const world = new World(ctx.cwd);
			const all = world.read();
			const ticket = all.find((t) => t.id === params.id);
			if (!ticket) throw new Error(`no ticket ${params.id}`);
			if (params.label !== undefined) ticket.label = params.label;
			if (params.priority !== undefined) ticket.priority = params.priority;
			if (params.status !== undefined) ticket.status = params.status as never;
			world.write(all);
			return json(ticket);
		},
	});

	pi.registerTool({
		name: "tickets_draft_reply",
		label: "Draft reply",
		description: "Save a reply draft on a ticket for a human agent to review and send.",
		parameters: Type.Object({ id: Type.String(), body: Type.String() }),
		outputSchema: Type.Object({ id: Type.String(), saved: Type.Boolean() }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		namespace,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const world = new World(ctx.cwd);
			const all = world.read();
			const ticket = all.find((t) => t.id === params.id);
			if (!ticket) throw new Error(`no ticket ${params.id}`);
			ticket.draft = params.body;
			world.write(all);
			return json({ id: ticket.id, saved: true });
		},
	});

	pi.registerCommand("tickets", {
		description: "Demo support desk: /tickets [reset <batch>]",
		handler: async (args, ctx) => {
			const world = new World(ctx.cwd);
			const [action, batch] = args.trim().split(/\s+/);
			if (action === "reset") world.reset(Number(batch) || 1);
			ctx.ui.notify(table(world.read()), "info");
		},
	});
}
