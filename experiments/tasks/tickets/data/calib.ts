/** Calibration split: tickets seen while decision sites gather agreement samples. Same row format as train. */
import type { Row } from "../dataset.ts";

export const CALIB: Row[] = [
	// episode 1
	["pro", "Annual plan charged instead of monthly", "I picked monthly at checkout but was billed $468 for the year. Please switch it to monthly and refund the difference.", "billing", "normal"],
	["free", "App crashes on launch after update", "Version 6.2 on Android 14 closes right after the splash screen. Reinstalling didn't help. I can't open any of my notes.", "technical", "urgent"],
	["enterprise", "Need an admin role for our IT lead", "Please grant Priya Raman the admin role. She manages our SSO setup and currently has only member rights.", "account", "low"],
	["pro", "Shortcut for inserting dates", "A keyboard shortcut to insert today's date would save me a lot of typing.", "product", "low"],
	["free", "Billing page is blank", "The Billing page renders completely white with a console error 'TypeError: plan is undefined'. I wanted to update my card.", "technical", "normal", "kw"],
	["enterprise", "Receipt for expense report", "Could you send a receipt for last month's payment made out to 'Northwind Labs BV'? Finance needs it this quarter.", "billing", "low"],
	["pro", "Can't remember which email I signed up with", "I have three addresses and none is recognised at login. Can you help me find my account? Nothing urgent.", "account", "normal"],
	["free", "Is there a student discount?", "I'm a grad student. Do you offer reduced pricing and how would I apply for it?", "product", "low", "kw"],
	["pro", "Webhook deliveries stopped", "Our endpoint has received no webhook events since yesterday 18:00, and your delivery log shows them as 'queued'. Order fulfilment depends on them and is piling up.", "technical", "urgent"],

	// episode 2
	["enterprise", "Unexpected overage fee", "We were billed $310 for API overage but our dashboard shows we stayed under quota. Please review the charge.", "billing", "normal"],
	["free", "Date picker shows the wrong weekday", "The date picker labels 3 March as a Tuesday, but it is a Monday. Tiny thing; I double-check dates by hand.", "technical", "normal", "tone"],
	["pro", "Merge two accounts", "I accidentally created a second account with my Gmail. Can both be merged under my work address?", "account", "low"],
	["pro", "Please make tables sortable", "Being able to click a column header to sort would be really helpful in the report view.", "product", "low"],
	["enterprise", "Data export contains other customers' rows", "The CSV export we ran at 10:12 includes about 200 rows that belong to a different organisation. We stopped using it but exports are still producing this.", "technical", "urgent"],
	["free", "Why was my card declined?", "My payment failed twice with 'declined' but the bank says nothing is wrong on their side. Can you check from your end?", "billing", "normal"],
	["pro", "how to set up recurring tasks", "I can't work out how to make a task repeat every Monday. Is that possible?", "product", "low"],
	["enterprise", "Seat limit reached, new hire blocked", "We are at our 50-seat limit and a new support agent starts in an hour with no way to log in. Please raise our seats to 55 now and bill us.", "billing", "urgent", "multi"],
	["free", "Old account on a dead email address", "I signed up years ago with a university address that no longer exists, so I can't get in. Could the account be moved to my current email? No hurry.", "account", "normal"],

	// episode 3
	["pro", "Charged after the trial though I cancelled", "I cancelled on day 12 of the 14-day trial and have the confirmation email, but was charged $29 on day 15.", "billing", "normal"],
	["enterprise", "Reports show yesterday's numbers", "Dashboards haven't refreshed since yesterday noon. Our ops floor is making staffing calls on stale data right now.", "technical", "urgent"],
	["free", "Deactivate my account", "I no longer need the service. Please close my account and confirm when it's done.", "account", "low"],
	["pro", "Love the product, one idea", "Great tool. It would be even better with a weekly summary email of what my team changed.", "product", "low"],
	["pro", "Two-factor codes rejected", "The six-digit codes from my authenticator are refused every time since I changed phones last week. I still have backup codes but they're running out.", "account", "normal"],
	["enterprise", "Purchase order billing", "We need to pay by purchase order with net-30 terms from next quarter. What do you need from us to set that up?", "billing", "low"],
	["free", "Images upside down", "Photos I upload from my iPhone appear rotated 180 degrees in the gallery. They look fine on the phone.", "technical", "normal"],
	["pro", "IMPORTANT: question about limits", "URGENT QUESTION!! How many projects can a Pro workspace have? I need to know before I plan next year.", "product", "low", "tone"],
	["free", "Request for comment — data breach story", "I'm a reporter at TechLedger writing about SaaS security incidents and would like a statement from your communications team by Friday.", "unassigned", null, "oos"],

	// episode 4
	["enterprise", "Wrong currency on invoices", "We're billed in USD but our contract says EUR. Please correct this from the next invoice on.", "billing", "normal"],
	["pro", "Editor freezes on long documents", "Typing in documents over 50 pages lags by several seconds per keystroke. Shorter ones are fine, so I split files for now.", "technical", "normal"],
	["free", "Locked out after too many attempts", "I mistyped my password and now see 'account locked for 24 hours'. I have a submission due tonight and my draft is in there.", "account", "urgent"],
	["pro", "Suggestion: templates for meeting notes", "A few built-in templates for meeting notes would make onboarding my team easier.", "product", "low"],
	["enterprise", "Calendar integration creates duplicates", "Every event synced from Google Calendar appears twice since Monday. People are getting double reminders but nothing is lost.", "technical", "normal"],
	["pro", "Tax exemption certificate", "We're a registered non-profit. I've attached our exemption certificate — please stop charging sales tax.", "billing", "low"],
	["free", "Where is the trash folder?", "I deleted a note by accident. Is there a bin I can restore it from and where do I find it?", "product", "low", "kw"],
	["enterprise", "Mobile app logs everyone out every few minutes", "Since the 6.3 release all our field staff are signed out roughly every five minutes and lose what they were typing. Around 120 people affected.", "technical", "urgent", "kw"],
	["free", "CHEAP SEO SERVICES!!!", "Get your website to #1 on Google. Guaranteed backlinks from $99. Reply for our rate card.", "unassigned", null, "oos"],
];
