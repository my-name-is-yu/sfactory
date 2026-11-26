/**
 * Exception and adaptation split. Each group backs one episode that departs from the trained task
 * in one way. Same row format as train. Extra tags: locked = the desk refuses updates to this
 * ticket, flaky = the first update attempt fails with a temporary error.
 */
import type { Row } from "../dataset.ts";

export const ADAPT: Record<string, Row[]> = {
	/** Ordinary tickets behind a heavily reworded request. */
	paraphrase: [
		["pro", "Billed for a seat we removed", "We dropped from 10 to 9 seats in April but May's invoice still charges for 10.", "billing", "normal"],
		["free", "Voice notes won't play", "Recorded voice notes show a spinner forever on playback. Text notes are fine.", "technical", "normal"],
		["enterprise", "Auditor needs read-only access today", "An external auditor is on site until 5pm and has no login. Please give her read-only access to the Finance space; without it the audit can't proceed.", "account", "urgent"],
		["pro", "Could comments support markdown?", "Formatting in comments would make code snippets readable.", "product", "low"],
		["free", "Gentle reminder about my earlier mail", "No pressure at all — only that our shared inbox has rejected every incoming customer email since this morning with 'mailbox unavailable'. We answer about 300 a day.", "technical", "urgent", "tone"],
		["pro", "Careers", "Do you sponsor visas for the open design position?", "unassigned", null, "oos"],
	],

	/** Tickets waiting in the "pending" queue: the ones to triage when the request names that queue. */
	pending: [
		["enterprise", "Credit note for the outage", "Per our SLA we're owed a 10% credit for last month's downtime. Please issue the credit note.", "billing", "low"],
		["pro", "Graphs render blank in Safari", "All charts are empty rectangles in Safari 18. Chrome shows them, so I switched browsers.", "technical", "normal"],
		["free", "I'm locked out and my thesis is in there", "The login form says my account doesn't exist. I defend my thesis tomorrow morning and all my notes are in the app.", "account", "urgent"],
		["pro", "Any plans for an Outlook add-in?", "We live in Outlook. An add-in to save emails as notes would be handy.", "product", "low"],
		["enterprise", "Bulk user import rejects valid CSV", "The user import fails with 'malformed row 1' for a file that matches your template exactly. We onboard 300 people on Thursday.", "technical", "normal", "kw"],
		["free", "Which plan includes version history?", "I can't tell from the pricing page whether Pro has version history or only Enterprise.", "product", "low", "kw"],
	],
	/** Open tickets present next to the pending queue. A pending-only request must not touch them. */
	bystanders: [
		["pro", "Refund request", "I was charged for an add-on I never enabled. Please refund $12.", "billing", "normal"],
		["free", "Keyboard stops responding in the editor", "After a few minutes of typing the editor ignores all keys until I reload the page.", "technical", "normal"],
		["enterprise", "Add a billing contact", "Please add ap@northwind.example as a second recipient for invoices.", "billing", "low"],
	],

	/** Ordinary tickets for the request that adds a requirement: also draft a reply for urgent ones. */
	extra: [
		["enterprise", "Payment run blocked", "Our finance team can't export the payment file: the button returns 'export failed' every time, and salaries must go out today.", "technical", "urgent"],
		["pro", "VAT charged on a reverse-charge invoice", "As an EU business with a valid VAT ID we should not be charged VAT, but the last invoice includes it.", "billing", "normal"],
		["free", "Profile photo", "How do I change my profile picture?", "product", "low"],
		["enterprise", "Service account locked before go-live", "Our integration's service account was locked for 'suspicious activity' and the go-live with our client is at noon. We need it unlocked now.", "account", "urgent"],
		["pro", "Mobile widget shows old tasks", "The home-screen widget shows tasks I completed days ago. Opening the app shows the right list.", "technical", "normal"],
		["free", "Idea: pomodoro timer", "A built-in focus timer next to tasks would be neat.", "product", "low"],
	],

	/** A queue several pages long. */
	volume: [
		["pro", "Receipt lists the wrong card", "The receipt says it was paid with a card ending 4410, but I only have one ending 9027. Was I charged correctly?", "billing", "normal"],
		["free", "Cannot paste images", "Pasting a screenshot into a note inserts nothing. Drag and drop works.", "technical", "normal"],
		["enterprise", "Rotate our admin", "Please make Jonas Feld the primary admin instead of me from the first of next month.", "account", "low"],
		["pro", "Gantt charts?", "Any chance of a timeline or Gantt view for projects?", "product", "low"],
		["free", "Charged in the wrong month", "My renewal date is the 20th but I was charged on the 2nd.", "billing", "normal"],
		["enterprise", "Search index missing a week of documents", "Nothing created between the 3rd and the 10th can be found through search. Legal is trying to locate contracts for a filing due today.", "technical", "urgent"],
		["pro", "Sign-in with Apple", "Can I switch my login from password to Sign in with Apple, and how?", "product", "low", "kw"],
		["free", "Education pricing invoice", "My school needs an invoice addressed to the district office instead of to me.", "billing", "low"],
		["enterprise", "Outbound emails land in spam", "Invitations and notifications sent by the platform to our customers are flagged as spam since yesterday. New customers can't activate their accounts.", "technical", "urgent"],
		["pro", "Unlink my Google account", "I want to stop using Google sign-in and use email and password instead. Please unlink it.", "account", "low"],
		["free", "Font size setting", "Is there a way to make the text larger in the reading view?", "product", "low"],
		["pro", "Refund of a duplicate annual payment", "I paid the annual fee by card and my company also paid it by bank transfer. Please refund one.", "billing", "normal"],
		["enterprise", "Audit log export is empty", "The audit log export downloads a file with only headers. The on-screen log is complete, so I copy from there.", "technical", "normal"],
		["free", "FWD: FWD: you won a prize", "Congratulations! Click here to claim your reward within 24 hours.", "unassigned", null, "oos"],
		["pro", "Timezone shown wrong on due dates", "Tasks due at 9:00 show as 8:00 for teammates in the same timezone as me since the clocks changed.", "technical", "normal"],
		["enterprise", "Deprovisioning doesn't remove access", "Users we remove in our identity provider keep full access here. We found three former employees still able to open customer files; it is still the case now.", "technical", "urgent", "kw"],
		["free", "Do you have an affiliate programme?", "I'd like to recommend you on my blog. Is there a referral or affiliate scheme I can join?", "product", "low"],
		["pro", "Switch from card to bank debit", "We'd like to pay by SEPA direct debit instead of card from the next cycle.", "billing", "low"],
		["free", "Second device not allowed?", "The app says 'device limit reached' when I sign in on my tablet. Is that expected on the free plan and how do I manage devices?", "product", "low", "kw"],
		["enterprise", "PLEASE READ: rename a field", "!!! Could the 'Company' field be called 'Organisation' in the British English locale? Our team finds it odd. !!!", "product", "low", "tone"],
		["pro", "Comments disappear after posting", "About one in three comments I post vanishes after a page refresh. My teammates see the same. It is still happening and we have lost decisions that were only written there.", "technical", "urgent"],
		["free", "Guardian consent form", "I'm 15. My teacher says I need my parents to sign something to use this for school. Who do I send it to?", "unassigned", null, "oos"],
		["enterprise", "December invoice never arrived", "The December invoice was never issued. Please send it when you can; our next payment run is in three weeks.", "billing", "normal"],
		["pro", "Share link opens a login wall", "Public share links now ask viewers to log in. We sent 40 proposals to prospects this morning with those links and none of them can open them.", "technical", "urgent"],
		["free", "Change the account holder's name", "I got married and my surname changed. Please update the name on the account.", "account", "low"],
		["pro", "Can exports be scheduled?", "I export the same report by hand every Monday. Is there a way to automate that today?", "product", "low"],
	],

	/** A queue where the desk does not cooperate on every ticket. */
	partial: [
		["pro", "Subscription renewed at the old price", "You confirmed a 20% loyalty discount by email, but the renewal charged full price.", "billing", "normal"],
		["enterprise", "Outage on the EU cluster", "Every page on the EU cluster times out for all of our users since 07:30. We run a hospital scheduling desk on it.", "technical", "urgent", "locked"],
		["free", "Recover a suspended account", "My account shows as suspended for inactivity. I'd like it back; there's no hurry.", "account", "normal", "flaky"],
		["pro", "Recurring events lose their end date", "When I edit a recurring event its end date resets to 'never'. I re-enter it each time.", "technical", "normal"],
		["free", "A/B testing feature?", "Do you support A/B tests on published pages?", "product", "low", "flaky"],
		["enterprise", "Wire transfer details", "Please send your bank details and a pro-forma invoice so we can pay this year's contract by wire.", "billing", "low"],
		["pro", "Remove my old phone from trusted devices", "I sold my old phone and want it removed from the trusted device list.", "account", "low", "locked"],
		["free", "Attachment preview shows garbled text", "PDF previews show boxes instead of letters for Japanese documents. Downloading the file works.", "technical", "normal"],
	],

	/** Tickets handled under a revised guide that adds a security team. Gold follows that guide. */
	drift: [
		["enterprise", "Possible account takeover", "Three logins to our admin account came from a country where we have no staff, last night between 02:00 and 03:00. None of us did that.", "security", "urgent"],
		["pro", "Refund for accidental upgrade", "I clicked Upgrade by mistake yesterday. Please revert to my old plan and refund the difference.", "billing", "normal"],
		["free", "I think I found a vulnerability", "Changing the id in the share URL shows me other users' private pages. I can send reproduction steps.", "security", "urgent", "kw"],
		["pro", "Phishing email that looks like yours", "I received a mail asking me to 'verify my billing details' at a domain that is not yours. I did not click. Thought you should know.", "security", "urgent", "kw"],
		["enterprise", "Table sorting ignores numbers", "Sorting a numeric column orders 10 before 9. We sort in a spreadsheet meanwhile.", "technical", "normal"],
		["free", "Can I set a longer session timeout?", "I get logged out after 30 minutes. Is there a setting to extend that?", "product", "low", "kw"],
	],

	/** A queue where most tickets are not something the desk's teams handle. */
	unknown: [
		["free", "Cease and desist", "Our client holds the trademark 'Brightline'. Your customer's workspace of the same name infringes it. Respond within 10 days.", "unassigned", null, "oos"],
		["pro", "Cobro duplicado", "Me han cobrado dos veces la suscripción de este mes. Por favor, devuélvanme uno de los cargos.", "billing", "normal"],
		["free", "Request to delete my personal data", "Under GDPR Article 17 I ask you to erase all personal data you hold about me and confirm in writing.", "unassigned", null, "oos"],
		["enterprise", "Podcast interview invitation", "We'd love to have your CEO on our show about remote work. Would she be available in October?", "unassigned", null, "oos"],
		["free", "wrong number?", "hi is this the pizza place on 5th, I'd like to order two large", "unassigned", null, "oos"],
		["pro", "My printer won't connect", "My HP printer no longer connects to my home Wi-Fi after a router change. Can you help?", "unassigned", null, "oos"],
	],
};
