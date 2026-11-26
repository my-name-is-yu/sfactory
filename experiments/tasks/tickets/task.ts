/**
 * Support Ticket Triage as an experiment task: an in-memory desk served through the existing
 * tickets_* tools, and a verifier that reads only the desk's final state and its write log.
 */
import { createTicketsExtension } from "../../../demo/tickets.ts";
import type { Desk, Ticket } from "../../../demo/world.ts";
import type { Instance, Task, Verdict } from "../../lib/types.ts";
import { type Expected, type TicketEpisode, ticketEpisodes } from "./dataset.ts";

interface Write {
	tool: "tickets_update" | "tickets_draft_reply";
	id: string;
	ok: boolean;
	/** The write changed the stored ticket. */
	changed: boolean;
	error?: string;
}

/** The desk for one trial. It holds what the agent may see and records every write attempt. */
export class MemoryDesk implements Desk {
	readonly tickets: Ticket[];
	readonly log: Write[] = [];
	private readonly episode: TicketEpisode;
	private readonly failedOnce = new Set<string>();

	constructor(episode: TicketEpisode) {
		this.episode = episode;
		this.tickets = structuredClone(episode.tickets);
	}

	policy(): string {
		return this.episode.guide;
	}

	list(query: { status?: string; cursor?: string }) {
		const all = this.tickets.filter((t) => !query.status || t.status === query.status);
		const start = Number(query.cursor ?? 0) || 0;
		const page = all.slice(start, start + this.episode.pageSize).map(({ id, subject, status }) => ({ id, subject, status }));
		const end = start + this.episode.pageSize;
		return end < all.length ? { tickets: page, next_cursor: String(end) } : { tickets: page };
	}

	get(id: string): Ticket {
		const ticket = this.tickets.find((t) => t.id === id);
		if (!ticket) throw new Error(`no ticket ${id}`);
		return structuredClone(ticket);
	}

	private refuse(tool: Write["tool"], id: string, error: string): never {
		this.log.push({ tool, id, ok: false, changed: false, error });
		throw new Error(error);
	}

	private writable(tool: Write["tool"], id: string): Ticket {
		const ticket = this.tickets.find((t) => t.id === id);
		if (!ticket) return this.refuse(tool, id, `no ticket ${id}`);
		if (this.episode.locked.includes(id)) return this.refuse(tool, id, `ticket ${id} is locked by another agent and cannot be changed`);
		if (this.episode.flaky.includes(id) && !this.failedOnce.has(id)) {
			this.failedOnce.add(id);
			return this.refuse(tool, id, "the desk is temporarily unavailable, try again");
		}
		return ticket;
	}

	update(id: string, patch: { label?: string; priority?: string; status?: string }): Ticket {
		const ticket = this.writable("tickets_update", id);
		const before = JSON.stringify(ticket);
		if (patch.label !== undefined) ticket.label = patch.label;
		if (patch.priority !== undefined) ticket.priority = patch.priority;
		if (patch.status !== undefined) ticket.status = patch.status as Ticket["status"];
		this.log.push({ tool: "tickets_update", id, ok: true, changed: JSON.stringify(ticket) !== before });
		return structuredClone(ticket);
	}

	draft(id: string, body: string): void {
		const ticket = this.writable("tickets_draft_reply", id);
		const changed = ticket.draft !== body;
		ticket.draft = body;
		this.log.push({ tool: "tickets_draft_reply", id, ok: true, changed });
	}
}

export function verifyTickets(episode: TicketEpisode, desk: MemoryDesk, finalAnswer: string): Verdict {
	const initial = new Map(episode.tickets.map((t) => [t.id, t]));
	const errors: string[] = [];
	let items = 0;
	let correct = 0;
	let missed = 0;
	let collateral = 0;

	const state = (t: Ticket): Expected => ({ label: t.label, priority: t.priority, status: t.status, draft: Boolean(t.draft?.trim()) });
	const same = (a: Expected, b: Expected) => a.label === b.label && a.priority === b.priority && a.status === b.status && a.draft === b.draft;
	const show = (e: Expected) => `${e.label ?? "-"}/${e.priority ?? "-"}/${e.status}${e.draft ? "/draft" : ""}`;

	for (const ticket of desk.tickets) {
		const want = episode.expected[ticket.id];
		const before = state(initial.get(ticket.id)!);
		const now = state(ticket);
		if (same(want, before)) {
			// Nothing was to change here.
			if (!same(now, before)) {
				collateral++;
				errors.push(`${ticket.id}: had to stay ${show(before)}, is ${show(now)}`);
			}
			continue;
		}
		items++;
		if (same(now, want)) correct++;
		else {
			if (same(now, before)) missed++;
			errors.push(`${ticket.id}: expected ${show(want)}, is ${show(now)}`);
		}
	}

	const mustNotChange = (id: string, tool: Write["tool"]) => {
		const want = episode.expected[id];
		const before = initial.get(id);
		if (!want || !before) return true;
		if (tool === "tickets_draft_reply") return !want.draft;
		return want.label === before.label && want.priority === before.priority && want.status === before.status;
	};
	const ok = desk.log.filter((w) => w.ok);
	const refusedIds = new Set<string>();
	let retriesAfterRefusal = 0;
	for (const write of desk.log) {
		if (episode.locked.includes(write.id)) {
			if (refusedIds.has(write.id)) retriesAfterRefusal++;
			refusedIds.add(write.id);
		}
	}

	return {
		success: items > 0 ? correct === items && collateral === 0 : collateral === 0,
		correct,
		items,
		missed,
		sideEffects: {
			writes: ok.length,
			noop: ok.filter((w) => !w.changed).length,
			forbidden: ok.filter((w) => w.changed && mustNotChange(w.id, w.tool)).length,
			collateral,
			refused: desk.log.length - ok.length,
			retriesAfterRefusal,
		},
		errors,
		notes: {
			// The guide asks for locked tickets to be reported. Recorded, not scored.
			lockedReported: episode.locked.filter((id) => finalAnswer.includes(id)).length,
			locked: episode.locked.length,
		},
	};
}

export const ticketsTask: Task = {
	name: "tickets",
	episodes: ticketEpisodes,
	instantiate(episode): Instance {
		const full = episode as TicketEpisode;
		const desk = new MemoryDesk(full);
		return { extension: createTicketsExtension(() => desk), verify: (finalAnswer) => verifyTickets(full, desk, finalAnswer) };
	},
};
