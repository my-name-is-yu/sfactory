/**
 * Training split: the tickets an agent meets while it learns the task. Each row is
 * [tier, subject, body, gold team, gold priority, tag]. The gold columns never reach the agent.
 * Tags: kw = the wording points at the wrong team, tone = the tone points at the wrong priority,
 * multi = two topics, oos = out of scope.
 */
import type { Row } from "../dataset.ts";

export const TRAIN: Row[] = [
	// episode 1
	["pro", "Charged twice for March", "Two identical charges of $49 appeared on the 3rd for the same workspace. Please refund the duplicate.", "billing", "normal"],
	["free", "Export button does nothing", "Clicking Export to PDF on any report does nothing in Chrome or Firefox. It worked last week.", "technical", "normal"],
	["enterprise", "Nobody can sign in since the maintenance", "Since last night's maintenance every login attempt ends on a 500 error page. All 40 of us are stuck and month-end close is today.", "technical", "urgent", "kw"],
	["pro", "Lost my authenticator phone", "My phone with the authenticator app was stolen. I need two-factor reset so I can get back in; I present to a client in an hour.", "account", "urgent"],
	["free", "Dark mode please", "Would love a dark theme for late-night work. No rush, just a wish.", "product", "low"],
	["pro", "How do I download old invoices?", "Where in the app can I get PDF invoices from last year? I looked under Settings and couldn't find them.", "product", "low", "kw"],
	["enterprise", "Add two seats to our plan", "We hired two analysts. Please move us from 25 to 27 seats starting next billing cycle and confirm the new price.", "billing", "low", "multi"],
	["free", "Collaboration opportunity", "We run a newsletter with 80k readers in your niche and would like to discuss a paid sponsorship with your marketing team.", "unassigned", null, "oos"],

	// episode 2
	["pro", "Invoice shows wrong VAT number", "Our February invoice lists VAT ID DE1234 but ours ends in 5678. We need a corrected invoice for the auditors by next week.", "billing", "normal"],
	["enterprise", "Sync is overwriting edits", "Edits made on tablets are replaced by older desktop versions after sync. We have lost field notes three times today and it keeps happening.", "technical", "urgent"],
	["free", "Change login email", "I'm moving jobs and want my account to use my personal address instead of the work one. How do I get that changed?", "account", "low"],
	["pro", "URGENT!!! need kanban view ASAP", "WE NEED A KANBAN BOARD VIEW IMMEDIATELY. Every other tool has one. This is unacceptable!!!", "product", "low", "tone"],
	["pro", "Refund not needed, app keeps charging after cancel fails", "I tried to cancel three times but the Cancel button shows 'Something went wrong' and the renewal went through again this morning. It is a small amount and I can wait for a fix.", "technical", "normal", "kw"],
	["enterprise", "Remove a departed employee", "Dana left the company last Friday. Please remove her access and transfer the dashboards she owned to me.", "account", "low"],
	["free", "Search is slow", "Search takes about ten seconds to return on a workspace with only 200 notes. It's usable but annoying.", "technical", "normal"],
	["pro", "Thanks!", "Just wanted to say the new editor is great. No action needed.", "product", "low"],

	// episode 3
	["enterprise", "Card expired, workspace suspended", "Our card expired and the workspace was suspended an hour ago. The support team can't reach customer records. I have a new card ready.", "billing", "urgent"],
	["free", "Can I use it offline?", "Is there an offline mode on the mobile app? I'll be on a long flight next month.", "product", "low"],
	["pro", "Password reset link says expired", "Every reset link I request says 'expired' the second I open it, even within ten seconds. I tried five times on two browsers. I'm still signed in on my laptop, so no hurry.", "technical", "normal", "kw"],
	["pro", "Downgrade to the Starter plan", "We don't use the advanced reports. Please switch us to Starter from next month.", "billing", "low"],
	["enterprise", "API returns 403 for all service tokens", "Since 14:00 UTC every request with a service token gets 403, though the tokens are valid and unchanged. Our nightly import to 12 clients fails.", "technical", "urgent", "kw"],
	["free", "Who owns the workspace now?", "The person who created our workspace left. I'm the only admin remaining and would like ownership moved to me. No rush, everything runs fine meanwhile.", "account", "low"],
	["pro", "Quiet note about missing attachments", "Not a big deal perhaps, but since Tuesday every attachment uploaded by our team shows 0 bytes. About 60 files so far, and new uploads still do it.", "technical", "urgent", "tone"],
	["free", "Application for the backend engineer role", "Please find my CV attached for the backend position listed on your careers page.", "unassigned", null, "oos"],
];
