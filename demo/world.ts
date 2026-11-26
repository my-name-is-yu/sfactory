/** A tiny support desk kept in one JSON file, so the demo has a world with real side effects. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Ticket {
	id: string;
	customer: string;
	subject: string;
	body: string;
	status: "open" | "pending" | "triaged" | "closed";
	label: string | null;
	priority: string | null;
	draft: string | null;
	/** Customer plan, when the desk tracks it. */
	tier?: string;
}

/** What the tickets_* tools need from a support desk. Errors thrown here become tool errors. */
export interface Desk {
	list(query: { status?: string; cursor?: string }): { tickets: Pick<Ticket, "id" | "subject" | "status">[]; next_cursor?: string };
	get(id: string): Ticket;
	update(id: string, patch: { label?: string; priority?: string; status?: string }): Ticket;
	draft(id: string, body: string): void;
	/** The desk's routing guide: teams, priorities and rules. */
	policy(): string;
}

const DEMO_POLICY = `Support desk routing guide
Teams (label): billing (charges, refunds, invoices), bug (something is broken), account (login and settings), feature_request (suggestions).
Priority: urgent when the customer is blocked or losing data, otherwise normal.
Set status to "triaged" once label and priority are set. Requests that fit no team are left for a human.`;

/** [subject, body]. The last two do not fit the usual categories. */
const POOL: [string, string][] = [
	["Charged twice this month", "My card shows two charges of $29 for the Pro plan on the 3rd. Please refund one of them."],
	["App crashes when exporting PDF", "Since the last update, clicking Export > PDF closes the app immediately. macOS 15, version 4.2.1."],
	["Can't log in after password reset", "I reset my password but the new one is rejected. I'm locked out and have a client demo in an hour!"],
	["Please add dark mode", "It would be great to have a dark theme. Not urgent, just a suggestion."],
	["Invoice has wrong company name", "Our invoices say 'Acme Ltd' but we are 'Acme GmbH'. Can you correct the March invoice?"],
	["Sync is losing my edits", "Edits I make on mobile disappear after the desktop syncs. I've lost two days of notes. This is urgent."],
	["How do I change my email?", "I want to move my account to a new email address. Where is that setting?"],
	["Export to CSV would help", "We'd love a CSV export for reports. Is that on the roadmap?"],
	["Refund for annual plan", "I upgraded to annual by mistake yesterday. Can I get a refund and go back to monthly?"],
	["Search returns nothing", "The search box returns no results for any query since this morning. All of our team is affected."],
	["Two-factor codes not arriving", "SMS codes for 2FA never arrive, so I can't sign in. Please help today."],
	["Keyboard shortcuts for tags", "A shortcut to add tags would speed things up. Low priority."],
	["Data deletion request under GDPR", "Under GDPR Article 17 I request erasure of all personal data you hold about me. Confirm in writing."],
	["Partnership proposal", "We run a reseller network in the Nordics and would like to discuss a partnership with your sales team."],
];

const CUSTOMERS = ["mika@example.com", "j.ortiz@example.com", "sam.lee@example.com", "priya@example.com", "tomas@example.com", "aiko@example.com"];

export const DEFAULT_SIZE = 6;

/** Deterministic tickets for a batch. Every third batch ends with a request that fits no usual category. */
export function seed(batch: number, size = DEFAULT_SIZE): Ticket[] {
	const ordinary = POOL.length - 2;
	return Array.from({ length: size }, (_, i) => {
		const unusual = batch % 3 === 0 && i === size - 1;
		const index = unusual ? ordinary + ((batch / 3) % 2) : ((batch - 1) * 5 + i * 3) % ordinary;
		const [subject, body] = POOL[index];
		return {
			id: `T-${batch}${String(i + 1).padStart(2, "0")}`,
			customer: CUSTOMERS[(batch + i) % CUSTOMERS.length],
			subject,
			body,
			status: "open",
			label: null,
			priority: null,
			draft: null,
		};
	});
}

export class World implements Desk {
	readonly path: string;

	constructor(cwd: string) {
		this.path = join(cwd, ".demo", "tickets.json");
	}

	read(): Ticket[] {
		if (!existsSync(this.path)) this.write(seed(1));
		return JSON.parse(readFileSync(this.path, "utf8")) as Ticket[];
	}

	write(tickets: Ticket[]): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(tickets, null, 1)}\n`);
	}

	list(query: { status?: string }) {
		return { tickets: this.read().filter((t) => !query.status || t.status === query.status).map(({ id, subject, status }) => ({ id, subject, status })) };
	}

	get(id: string): Ticket {
		const ticket = this.read().find((t) => t.id === id);
		if (!ticket) throw new Error(`no ticket ${id}`);
		return ticket;
	}

	update(id: string, patch: { label?: string; priority?: string; status?: string }): Ticket {
		const all = this.read();
		const ticket = all.find((t) => t.id === id);
		if (!ticket) throw new Error(`no ticket ${id}`);
		if (patch.label !== undefined) ticket.label = patch.label;
		if (patch.priority !== undefined) ticket.priority = patch.priority;
		if (patch.status !== undefined) ticket.status = patch.status as Ticket["status"];
		this.write(all);
		return ticket;
	}

	draft(id: string, body: string): void {
		const all = this.read();
		const ticket = all.find((t) => t.id === id);
		if (!ticket) throw new Error(`no ticket ${id}`);
		ticket.draft = body;
		this.write(all);
	}

	policy(): string {
		return DEMO_POLICY;
	}

	reset(batch: number, size = DEFAULT_SIZE): Ticket[] {
		const tickets = seed(batch, size);
		this.write(tickets);
		return tickets;
	}
}

export function table(tickets: Ticket[]): string {
	return tickets
		.map((t) => `${t.id}  ${t.status.padEnd(7)} ${(t.label ?? "-").padEnd(16)} ${(t.priority ?? "-").padEnd(7)} ${t.draft ? "draft " : "      "} ${t.subject}`)
		.join("\n");
}
