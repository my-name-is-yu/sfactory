/** Unseen evaluation split. No ticket here appears in any other split. Same row format as train. */
import type { Row } from "../dataset.ts";

export const TEST: Row[] = [
	// episode 1
	["pro", "Refund for unused months", "We're closing the project in June. Can the remaining six months of our annual plan be refunded pro rata?", "billing", "low"],
	["enterprise", "Import job stuck at 0%", "A 2 GB import started four hours ago still shows 0%. We migrate from our old system tonight and can't start until it completes.", "technical", "urgent"],
	["free", "New phone number for verification", "My mobile number changed. I can still sign in with a backup code but want SMS verification moved to the new number.", "account", "low"],
	["pro", "Is there a way to tag notes in bulk?", "I have 300 untagged notes. Can I select many and tag them at once, or does that not exist yet?", "product", "low"],
	["pro", "Payment succeeded but plan still shows Free", "My card was charged $29 this morning and I have the receipt, yet the workspace is still on Free and the Pro features stay locked.", "technical", "normal", "kw"],
	["enterprise", "Access review before audit", "For our SOC 2 audit I need the list of users with admin rights reduced to three named people. The auditors arrive in two weeks.", "account", "low"],
	["free", "It would be nice to have emoji reactions", "Small thing: reactions on comments would be fun.", "product", "low"],
	["pro", "Notifications arrive hours late", "Mention notifications reach me three to four hours after the comment. I check the app by hand for now.", "technical", "normal"],

	// episode 2
	["enterprise", "Double billing across two workspaces", "After you merged our two workspaces we are still invoiced for both. Please cancel the old subscription and credit last month's duplicate.", "billing", "normal"],
	["free", "Site won't load at all", "app.example.com shows 'This site can't be reached' on every device and network I try, and your status page says an incident is in progress.", "technical", "urgent"],
	["pro", "Transfer my licence to a colleague", "I'm changing teams. Please reassign my seat to Leo Marchetti and remove my access at the end of the week.", "account", "low"],
	["pro", "how do I cancel?", "I can't find where to cancel my subscription. Could you point me to it?", "product", "low", "kw"],
	["enterprise", "Project vanished on its own", "The 'Q3 Launch' project disappeared from every member's sidebar twenty minutes ago. Nobody deleted it and the trash is empty. The launch review is this afternoon.", "technical", "urgent"],
	["free", "Discount missing from the invoice", "I used the code SPRING20 at checkout and it was accepted, but the invoice I received shows the full price.", "billing", "normal"],
	["pro", "ASAP: logo upload", "NEED THIS NOW — when will custom logos on shared pages be available?? Our brand team keeps asking.", "product", "low", "tone"],
	["enterprise", "Make five guests full members", "Five contractors who joined as guests are now employees. Please make them full members within our existing seats; names are in the attached list.", "account", "low"],

	// episode 3
	["pro", "Charge in the wrong amount", "The plan is listed at $19 but I was charged $29. Nothing changed on my side.", "billing", "normal"],
	["free", "Battery drain on iOS", "Since the last update the app uses about 40% of my battery in the background per day.", "technical", "normal"],
	["enterprise", "Owner left, nobody can manage billing or members", "Our only workspace owner left the company and her mailbox is closed. Ten new hires start Monday and no one can invite them.", "account", "normal"],
	["free", "Do you have a Linux desktop app?", "I use Ubuntu. Is there a native app or only the web version?", "product", "low"],
	["pro", "Our client can see internal comments", "A client with view-only access to a shared page can read comments marked internal. Noticed ten minutes ago; the page is still shared with six clients.", "technical", "urgent"],
	["free", "Partnership inquiry from a reseller", "We distribute software to schools in Brazil and would like to discuss becoming an authorised reseller.", "unassigned", null, "oos"],

	// episode 4
	["enterprise", "Renewal quote for 200 seats", "Our contract renews in March. Please send a renewal invoice for 200 seats at the agreed rate so procurement can process it.", "billing", "low"],
	["pro", "PDF export cuts off tables", "Wide tables are truncated at the right page edge in exported PDFs. Landscape export avoids it, so I use that for now.", "technical", "normal"],
	["free", "Reset email never arrives", "I asked for a password reset six times over two days. Nothing in inbox or spam, and your status page lists email delivery as degraded.", "technical", "normal", "kw"],
	["pro", "Change workspace name", "We rebranded. How do I rename the workspace from 'Acme Media' to 'Brightline'?", "product", "low", "kw"],
	["enterprise", "All scheduled reports failed overnight", "None of our 60 scheduled reports were sent this morning; each shows 'render timeout'. Regional managers start their day without numbers.", "technical", "urgent"],
	["free", "Charged but I never signed up", "There is a $29 charge from you on my card and I have never had an account. Please explain or refund.", "billing", "normal"],
	["pro", "Give our contractor temporary access", "A contractor needs edit access to one project for three weeks. What's the right way to do that without a full seat?", "product", "low", "kw"],
	["enterprise", "calm heads-up on storage", "For your awareness: uploads have failed with 'quota exceeded' since about 08:00 although we're at 40% of our quota. Sales can't attach contracts to deals.", "technical", "urgent", "tone"],
	["pro", "Subpoena for user records", "Please find attached a subpoena requiring production of account records for the user named therein within 14 days.", "unassigned", null, "oos"],
	["free", "asdf", "kjh sdfkjh 2398 ??", "unassigned", null, "oos"],
];
