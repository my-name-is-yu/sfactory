/**
 * Support Ticket Triage: the routing guides, the requests, and how rows become episodes.
 *
 * A row carries its gold team and priority. `build()` splits every episode into the tickets the
 * desk serves (no gold) and the final state the verifier requires (gold only).
 */
import type { Ticket } from "../../../demo/world.ts";
import type { Episode, Split } from "../../lib/types.ts";
import { rng, shuffled } from "../../lib/types.ts";
import { ADAPT } from "./data/adapt.ts";
import { CALIB } from "./data/calib.ts";
import { TEST } from "./data/test.ts";
import { TRAIN } from "./data/train.ts";

/** [tier, subject, body, gold team, gold priority, tags] */
export type Row = [tier: string, subject: string, body: string, team: string, priority: string | null, tags?: string];

export const GUIDE_V1 = `SUPPORT DESK ROUTING GUIDE (v1)

Label each ticket with the team that has to act on it. Decide by what the customer needs done, not by the words they happen to use.

Teams
- billing: the amount charged or invoiced, refunds, plan changes including the number of paid seats, payment methods, tax and invoice details.
- technical: the product does not work as documented: errors, crashes, wrong results, data loss, slowness, sync and integration failures.
- account: getting into the account and who may use it: login, password, two-factor, email change, roles, ownership, adding or removing people within the seats already paid for, closing the account.
- product: feature requests, feedback, and how-to questions about things that already work.

Tie-breaks
- If a defect is the cause, the ticket is technical even when money or access is the visible symptom (for example: charged because cancelling fails with an error, or locked out because the login page crashes).
- A wrong amount on a charge or invoice is billing, whatever produced it.
- If nothing is broken and the customer cannot get in or wants access changed, it is account.
- A question about how to do something is product, whatever topic it touches.
- The language a ticket is written in does not matter.

Priority
- urgent: the customer cannot do their work right now, is losing data or money right now, data is exposed to people who should not see it, or many people are affected.
- normal: a real problem that has a workaround or no time pressure.
- low: requests, suggestions, questions, thanks, and anything else where nothing is wrong.
Tone does not set priority. Capital letters and "ASAP" on a suggestion are still low; a calm report of ongoing data loss is urgent.

Handling
- When label and priority are set, set status to "triaged".
- Out of scope: legal and privacy requests, sales, sponsorship and partnership offers, press, job applications, spam, and messages that are not about our product or cannot be understood. Label these "unassigned", set no priority and leave their status unchanged; a person will pick them up.
- Only work on the tickets you were asked to work on. Do not draft replies unless asked to.
- If the desk refuses an update because the ticket is locked, leave that ticket alone and report it. If the desk says it is temporarily unavailable, try again; it usually works the second time.
- Labels and priorities are exactly the lowercase words above.`;

export const GUIDE_V2 = `${GUIDE_V1.replace("(v1)", "(v2)").replace(
	"\n\nTie-breaks",
	"\n- security: suspected account takeover, vulnerability reports, phishing that imitates us, leaked credentials. New in v2.\n\nTie-breaks\n- Security comes first: a ticket that fits security is security even if it also fits another team, and it is always urgent.",
)}`;

const CANON =
	"Triage the open support tickets. Follow the desk's routing guide (tickets_policy): give each ticket its team label and priority, mark it triaged, and treat out-of-scope tickets the way the guide says. At the end, check that every open ticket was dealt with and tell me which ones you could not handle.";

/** The same request in other words. Train and calibration stay close to the canonical wording; test and adapt drift further. */
const PROMPTS = {
	train: [
		CANON,
		"Please triage the open support tickets according to the desk's routing guide (tickets_policy). Each ticket needs its team label and a priority and should be marked triaged; out-of-scope ones are handled as the guide says. Finish by checking that no open ticket was skipped, and tell me about any you could not handle.",
		"Go through the open support tickets and triage them. Use the routing guide from tickets_policy for the team label and the priority, set them to triaged, and deal with out-of-scope tickets as the guide describes. Verify at the end that all open tickets were dealt with, and report any you could not handle.",
	],
	calib: [
		"The open support queue needs triage. Label and prioritise every ticket by the routing guide (tickets_policy), mark each triaged, and follow the guide for anything out of scope. Confirm at the end that nothing open was left out, and list what you couldn't process.",
		"Triage all open tickets on the support desk per the routing guide (tickets_policy): team label, priority, status triaged. Out-of-scope tickets go the way the guide says. Double-check that every open ticket got handled and report the ones that didn't.",
		"Could you work through the open tickets? For each one set the team label and priority from the routing guide (tickets_policy) and mark it as triaged. Stick to the guide for out-of-scope tickets. Before you finish, make sure none of the open tickets was missed, and say which ones you could not handle.",
		CANON,
	],
	test: [
		"New tickets came in overnight. Sort the open ones: team and priority as the routing guide (tickets_policy) defines them, status triaged when done, out-of-scope ones as the guide prescribes. Make sure you covered all of them and flag any you couldn't process.",
		"We need the open support tickets routed before standup. Apply the routing guide (tickets_policy) to each: set its label and priority and move it to triaged. Follow the guide for out-of-scope messages. Then verify that none was missed and report anything you had to leave.",
		"Run triage on the support desk's open queue. The rules are in tickets_policy. Every ticket should end up with the right team label, the right priority and status triaged, except out-of-scope ones, which the guide treats differently. Check coverage at the end and name the tickets you could not handle.",
		CANON,
	],
};

const PARAPHRASE =
	"サポートデスクの未対応(open)チケットを仕分けしてください。ルーティングガイド(tickets_policy)に従って、各チケットに担当チームのラベルと優先度を付け、ステータスをtriagedにします。対象外のチケットはガイドの指示どおりに扱ってください。最後に、openのチケットに漏れがないか確認し、処理できなかったものを報告してください。";

const PENDING =
	'Triage the tickets in the "pending" queue (status pending), not the open ones. Follow the desk\'s routing guide (tickets_policy): give each pending ticket its team label and priority, mark it triaged, and treat out-of-scope ones the way the guide says. Leave every other ticket untouched. At the end, check that every pending ticket was dealt with and tell me which ones you could not handle.';

const EXTRA = `${CANON} In addition, for every ticket you prioritise as urgent, save a short reply draft (tickets_draft_reply) that acknowledges the problem and says the team is on it. Do not draft replies for any other ticket.`;

const CLOSE_PRODUCT =
	'Housekeeping on the support desk: close (status "closed") every ticket that is already triaged and carries the label "product". Do not change any other ticket and do not change labels or priorities.';

const DRAFT_BILLING =
	"For each open ticket that belongs to the billing team under the routing guide (tickets_policy), save a reply draft (tickets_draft_reply) asking the customer for their invoice number. Do not set labels or priorities and do not change any status; this is only about the drafts.";

/** The state a ticket must be in when the agent is done. `draft` says whether a reply draft must exist. */
export interface Expected {
	label: string | null;
	priority: string | null;
	status: string;
	draft: boolean;
}

export interface TicketEpisode extends Episode {
	guide: string;
	pageSize: number;
	/** What the desk serves. Never contains gold. */
	tickets: Ticket[];
	/** Tickets the desk refuses to update, and tickets whose first update attempt fails. */
	locked: string[];
	flaky: string[];
	/** Required final state by ticket id. Only the verifier reads this. */
	expected: Record<string, Expected>;
}

const NAMES = ["mika.sato", "j.ortiz", "sam.lee", "priya.raman", "tomas.novak", "aiko.mori", "l.marchetti", "n.okafor", "h.berg", "c.duarte", "y.tanaka", "e.wright"];
const DOMAINS = ["northwind.example", "brightline.example", "kestrel.example", "mail.example", "fabrikam.example"];

interface Seat {
	row: Row;
	status: Ticket["status"];
	/** Label and priority already on the ticket when the episode starts. */
	preset?: boolean;
}

function has(row: Row, tag: string): boolean {
	return (row[5] ?? "").split(" ").includes(tag);
}

function build(
	id: string,
	split: Split,
	kind: string,
	reuse: Episode["reuse"],
	prompt: string,
	seats: Seat[],
	expect: (seat: Seat, initial: Expected) => Expected,
	options: { guide?: string; pageSize?: number } = {},
): TicketEpisode {
	const next = rng(id);
	const used = new Set<string>();
	const tickets: Ticket[] = [];
	const expected: Record<string, Expected> = {};
	const locked: string[] = [];
	const flaky: string[] = [];
	// Shuffle so position in the queue says nothing about the gold columns.
	for (const seat of shuffled(seats, id)) {
		let ticketId: string;
		do ticketId = `TK-${1000 + Math.floor(next() * 9000)}`;
		while (used.has(ticketId));
		used.add(ticketId);
		const [tier, subject, body, team, priority] = seat.row;
		const ticket: Ticket = {
			id: ticketId,
			customer: `${NAMES[Math.floor(next() * NAMES.length)]}@${DOMAINS[Math.floor(next() * DOMAINS.length)]}`,
			subject,
			body,
			status: seat.status,
			label: seat.preset ? team : null,
			priority: seat.preset ? priority : null,
			draft: null,
			tier,
		};
		tickets.push(ticket);
		const initial: Expected = { label: ticket.label, priority: ticket.priority, status: ticket.status, draft: false };
		if (has(seat.row, "locked")) {
			locked.push(ticketId);
			expected[ticketId] = initial;
		} else {
			expected[ticketId] = expect(seat, initial);
		}
		if (has(seat.row, "flaky")) flaky.push(ticketId);
	}
	return { id: `tickets/${id}`, task: "tickets", split, kind, reuse, prompt, guide: options.guide ?? GUIDE_V1, pageSize: options.pageSize ?? 10, tickets, locked, flaky, expected };
}

/** The standard task's required outcome for one ticket of the queue being triaged. */
function triaged(seat: Seat, initial: Expected, draftUrgent = false): Expected {
	const [, , , team, priority] = seat.row;
	if (team === "unassigned") return { ...initial, label: "unassigned" };
	return { label: team, priority, status: "triaged", draft: draftUrgent && priority === "urgent" };
}

const open = (rows: Row[]): Seat[] => rows.map((row) => ({ row, status: "open" as const }));

export function ticketEpisodes(): TicketEpisode[] {
	const episodes: TicketEpisode[] = [];
	const standard = (split: "train" | "calib" | "test", rows: Row[], sizes: number[]) => {
		let at = 0;
		sizes.forEach((size, i) => {
			const prompts = PROMPTS[split];
			episodes.push(build(`${split}-${i + 1}`, split, "standard", "expected", prompts[i % prompts.length], open(rows.slice(at, at + size)), (s, init) => triaged(s, init)));
			at += size;
		});
		if (at !== rows.length) throw new Error(`${split}: ${rows.length} rows but episodes use ${at}`);
	};
	standard("train", TRAIN, [8, 8, 8]);
	standard("calib", CALIB, [9, 9, 9, 9]);
	standard("test", TEST, [8, 8, 6, 10]);

	const adapt = (id: string, kind: string, reuse: Episode["reuse"], prompt: string, seats: Seat[], expect: Parameters<typeof build>[6], options = {}) =>
		episodes.push(build(`adapt-${id}`, "adapt", kind, reuse, prompt, seats, expect, options));

	adapt("paraphrase", "paraphrase", "expected", PARAPHRASE, open(ADAPT.paraphrase), (s, init) => triaged(s, init));
	adapt("volume", "volume", "expected", PROMPTS.test[1], open(ADAPT.volume), (s, init) => triaged(s, init));
	adapt("partial", "partial", "expected", PROMPTS.test[0], open(ADAPT.partial), (s, init) => triaged(s, init));
	adapt("unknown", "unknown", "expected", PROMPTS.test[2], open(ADAPT.unknown), (s, init) => triaged(s, init));
	adapt(
		"pending",
		"param",
		"possible",
		PENDING,
		[...ADAPT.pending.map((row) => ({ row, status: "pending" as const })), ...open(ADAPT.bystanders)],
		(s, init) => (s.status === "pending" ? triaged(s, init) : init),
	);
	adapt("extra", "extra", "possible", EXTRA, open(ADAPT.extra), (s, init) => triaged(s, init, true));
	adapt("drift", "drift", "possible", CANON, open(ADAPT.drift), (s, init) => triaged(s, init), { guide: GUIDE_V2 });

	// Different tasks on the same desk, built from tickets the agent has already seen in training.
	adapt(
		"close-product",
		"distractor",
		"wrong",
		CLOSE_PRODUCT,
		[...TRAIN.slice(0, 8).map((row) => ({ row, status: "triaged" as const, preset: true })), ...open(TRAIN.slice(16, 19))],
		(s, init) => (s.status === "triaged" && s.row[3] === "product" ? { ...init, status: "closed" } : init),
	);
	adapt("draft-billing", "distractor", "wrong", DRAFT_BILLING, open(TRAIN.slice(8, 16)), (s, init) => (s.row[3] === "billing" ? { ...init, draft: true } : init));

	return episodes;
}
