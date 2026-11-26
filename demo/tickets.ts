/**
 * Support desk tools. Loaded as an extension, they work on a small desk kept in `.demo/tickets.json`:
 *
 *   /tickets reset 2     replace the desk with batch 2 (all tickets open again)
 *   /tickets             show the desk
 *
 * `createTicketsExtension` serves any other `Desk` through the same tools, which the experiments use.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Desk, table, World } from "./world.ts";

const Nullable = Type.Union([Type.String(), Type.Null()]);
const TicketSchema = Type.Object({
	id: Type.String(),
	customer: Type.String(),
	subject: Type.String(),
	body: Type.String(),
	status: Type.String(),
	label: Nullable,
	priority: Nullable,
	draft: Nullable,
	tier: Type.Optional(Type.String()),
});

export const TICKET_TOOLS = ["tickets_policy", "tickets_list", "tickets_get", "tickets_update", "tickets_draft_reply"];

export function createTicketsExtension(open: (cwd: string) => Desk) {
	return (pi: ExtensionAPI) => {
		const namespace = { name: "tickets", description: "The support desk: list, read, label and answer customer tickets" };
		const json = (value: unknown) => ({
			content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
			details: undefined,
			structuredContent: value as never,
		});

		pi.registerTool({
			name: "tickets_policy",
			label: "Routing guide",
			description: "Read the desk's routing guide: the teams, the priorities, and the rules for handling tickets.",
			parameters: Type.Object({}),
			outputSchema: Type.Object({ guide: Type.String() }),
			annotations: { readOnlyHint: true },
			namespace,
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				return json({ guide: open(ctx.cwd).policy() });
			},
		});

		pi.registerTool({
			name: "tickets_list",
			label: "List tickets",
			description:
				"List tickets, optionally only those with a given status. Returns id, subject and status. " +
				"Long lists come in pages: when the result has next_cursor, call again with cursor to get the next page.",
			parameters: Type.Object({ status: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()) }),
			outputSchema: Type.Object({
				tickets: Type.Array(Type.Object({ id: Type.String(), subject: Type.String(), status: Type.String() })),
				next_cursor: Type.Optional(Type.String()),
			}),
			annotations: { readOnlyHint: true },
			namespace,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return json(open(ctx.cwd).list(params));
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
				return json(open(ctx.cwd).get(params.id));
			},
		});

		pi.registerTool({
			name: "tickets_update",
			label: "Update ticket",
			description: "Set a ticket's label, priority and/or status. Returns the ticket as stored.",
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
				const { id, ...patch } = params;
				return json(open(ctx.cwd).update(id, patch));
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
				open(ctx.cwd).draft(params.id, params.body);
				return json({ id: params.id, saved: true });
			},
		});
	};
}

export default function tickets(pi: ExtensionAPI) {
	createTicketsExtension((cwd) => new World(cwd))(pi);
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
