/**
 * System tour: how the whole process works, step by step, for every role.
 * Pure data + resolution through the route policy, so the tour only ever links
 * to pages the signed-in user may open (same rule as the navigation).
 */
import {
  evaluateRoute,
  pathFor,
  type AccessFacts,
  type ClientRole,
  type FirmRole,
  type RouteKey,
} from "@/lib/access/route-policy";

export type TourRole = FirmRole | ClientRole;

interface TourLinkDef {
  route: RouteKey;
  label: string;
  /** Which client id the link needs: one the user is a member of, or staff on. */
  scope?: "member" | "staff";
}

export interface TourStepDef {
  id: string;
  title: string;
  stage: "Set up" | "Collect" | "Record" | "Report" | "Tax" | "File" | "Run the firm";
  who: TourRole[];
  summary: string;
  happens: string[];
  safeguards: string[];
  links: TourLinkDef[];
}

export const ROLE_LABELS: Record<TourRole, string> = {
  firm_admin: "Firm admin",
  firm_manager: "Firm manager",
  reviewer: "Reviewer",
  accountant: "Accountant",
  bookkeeper: "Bookkeeper",
  client_owner: "Client owner",
  client_staff: "Client staff",
  client_viewer: "Client viewer",
};

const STAFF: TourRole[] = ["firm_manager", "reviewer", "accountant", "bookkeeper"];
const CLIENT_WRITERS: TourRole[] = ["client_owner", "client_staff"];

export const TOUR_STEPS: TourStepDef[] = [
  {
    id: "invite",
    title: "1. People join by invitation",
    stage: "Set up",
    who: ["firm_admin", "firm_manager", "client_owner"],
    summary:
      "Nobody signs up on their own. The firm invites its staff and its clients; each person sees only what their role and assignments allow.",
    happens: [
      "A firm admin invites staff and gives each a firm role (manager, reviewer, accountant, bookkeeper).",
      "A firm manager creates a client business and invites its owner; the owner can invite their own staff or viewers.",
      "A firm manager assigns staff to clients. Staff only see the clients they are assigned to (managers see all).",
    ],
    safeguards: [
      "Every client's data is walled off from every other client by the database itself (row-level security).",
      "Firm admins manage people but cannot open any client's books.",
      "Nobody can change their own role, and the last admin cannot be removed.",
    ],
    links: [
      { route: "admin.invitations", label: "Invitations" },
      { route: "admin.clients", label: "Clients" },
      { route: "review.assignments", label: "Staff assignments" },
      { route: "portal.team", label: "Your team", scope: "member" },
    ],
  },
  {
    id: "profile",
    title: "2. The business profile and books are set up",
    stage: "Set up",
    who: ["client_owner", "reviewer", "firm_manager", "accountant"],
    summary:
      "The client describes the business; the firm checks it and prepares the chart of accounts, fiscal year and settings.",
    happens: [
      "The client owner fills in the business profile (registration details, VAT status as declared) and submits it.",
      "A reviewer checks and approves the profile.",
      "A reviewer applies the chart-of-accounts template, opens the fiscal year (12 monthly periods) and sets the sales, purchase and inventory settings.",
    ],
    safeguards: [
      "Declared facts are shown as declared until the firm verifies them.",
      "Accounts cannot be deleted or have their type changed once used.",
    ],
    links: [
      { route: "portal.profile", label: "Business profile", scope: "member" },
      { route: "staff.accounts", label: "Chart of accounts", scope: "staff" },
      { route: "staff.periods", label: "Periods", scope: "staff" },
    ],
  },
  {
    id: "submit",
    title: "3. The client sends in records",
    stage: "Collect",
    who: [...CLIENT_WRITERS, "accountant", "bookkeeper"],
    summary:
      "Sales, purchases, expenses, collections and payments come in as transactions with their supporting documents, one at a time or by spreadsheet import.",
    happens: [
      "The client records a transaction and attaches the invoice or receipt, then submits it.",
      "Files are uploaded to a private vault; each file's type is checked and its fingerprint (SHA-256) stored.",
      "Larger batches come in by spreadsheet import, which is checked row by row before anything is saved.",
      "When the firm needs something missing, it sends a document request; the client answers it on the Requests page.",
    ],
    safeguards: [
      "The same submission is recorded only once, even if the button is pressed twice or the connection retries.",
      "The same file cannot be stored twice for a client; executables and disguised files are refused.",
      "Viewers can read but not submit.",
    ],
    links: [
      { route: "portal.transactions", label: "Transactions", scope: "member" },
      { route: "portal.documents", label: "Documents", scope: "member" },
      { route: "portal.imports", label: "Imports", scope: "member" },
      { route: "portal.requests", label: "Requests", scope: "member" },
    ],
  },
  {
    id: "review",
    title: "4. The firm reviews what came in",
    stage: "Collect",
    who: ["accountant", "bookkeeper", "reviewer", "firm_manager"],
    summary:
      "Staff check each submission against its documents, then a reviewer approves it, or it goes back to the client with a note.",
    happens: [
      "An accountant reviews the submission and marks it reviewed, or returns it with what needs fixing.",
      "A reviewer approves it. Approved items are ready to be recorded in the books.",
      "Comments and every status change are kept with who did it and when.",
    ],
    safeguards: [
      "The person who prepares something can never be the one who approves it (maker-checker).",
      "Clients cannot approve their own submissions.",
    ],
    links: [
      { route: "review", label: "Review queue" },
      { route: "staff.intake", label: "Intake", scope: "staff" },
    ],
  },
  {
    id: "post",
    title: "5. Approved items are posted to the ledger",
    stage: "Record",
    who: ["accountant", "reviewer", "firm_manager"],
    summary:
      "Approved submissions become sales invoices, bills, receipts, payments, inventory movements, payroll runs or journal entries. A reviewer posts them.",
    happens: [
      "An accountant prepares the document (e.g. a sales invoice from the approved submission); the system computes VAT and totals.",
      "A reviewer posts it. Posting creates a balanced journal entry (debits = credits) in the right period.",
      "Receipts and payments are allocated to invoices and bills, so receivables and payables stay current.",
    ],
    safeguards: [
      "An entry that does not balance can never be posted: the database refuses it.",
      "Posted entries can never be edited or deleted. Mistakes are corrected with a reversal, so the history stays intact.",
      "A source document can be booked only once.",
    ],
    links: [
      { route: "staff.sales", label: "Sales & receivables", scope: "staff" },
      { route: "staff.purchases", label: "Purchases & payables", scope: "staff" },
      { route: "staff.journal", label: "Journal", scope: "staff" },
    ],
  },
  {
    id: "close",
    title: "6. Month-end: reconcile and close the period",
    stage: "Report",
    who: ["reviewer", "firm_manager", "accountant"],
    summary:
      "At month-end the firm checks that every sub-ledger agrees with the books, then closes the month so nothing changes behind the reports.",
    happens: [
      "Receivables, payables, inventory and payroll are reconciled to the ledger (the difference must be zero).",
      "The trial balance and general ledger are reviewed.",
      "A reviewer soft-closes the month; a manager locks it when the month's filings are done.",
    ],
    safeguards: [
      "A locked month can only be reopened through an exception request approved by a different manager.",
      "Every reopening is recorded with its reason.",
    ],
    links: [
      { route: "staff.trial_balance", label: "Trial balance", scope: "staff" },
      { route: "staff.ledger", label: "General ledger", scope: "staff" },
      { route: "staff.periods", label: "Periods", scope: "staff" },
    ],
  },
  {
    id: "reports",
    title: "7. Financial statements",
    stage: "Report",
    who: [
      "reviewer",
      "firm_manager",
      "accountant",
      "client_owner",
      "client_staff",
      "client_viewer",
    ],
    summary:
      "Income statement, balance sheet, cash flow and aging come straight from posted entries, with drill-down to every line.",
    happens: [
      "Staff run statements for any period and compare periods; every figure drills down to its entries.",
      "Clients see their statements for closed months only, so they never see figures still being worked on.",
      "Statements export to CSV.",
    ],
    safeguards: [
      "Statements are computed from posted entries only; they always equal the trial balance.",
    ],
    links: [
      { route: "staff.reports", label: "Reports", scope: "staff" },
      { route: "portal.reports", label: "Financial statements", scope: "member" },
    ],
  },
  {
    id: "tax",
    title: "8. Tax computations",
    stage: "Tax",
    who: ["accountant", "reviewer", "firm_manager"],
    summary:
      "Taxes are computed from the books using rules the firm has verified. The platform ships with no rules; each one is entered and approved by the firm.",
    happens: [
      "A rule is entered with its official source (issuance and date) and worked examples (fixtures), checked by a second accountant and approved by another person.",
      "For each client, the firm records which taxes apply and which accounts feed each rule.",
      "An accountant computes the tax for a period; a reviewer reviews the result. Every number traces back to its ledger lines.",
    ],
    safeguards: [
      "No rule is used until it passes its approval gate; without one, the period is marked unsupported (prepare it manually).",
      "Rules are versioned by effective date. A new rule never changes an earlier computation; recalculating is a deliberate, reviewed step.",
      "Regression tests re-run every rule's examples after any change.",
    ],
    links: [
      { route: "tax_rules", label: "Tax rules registry" },
      { route: "staff.tax", label: "Tax", scope: "staff" },
    ],
  },
  {
    id: "forms",
    title: "9. BIR form workpapers",
    stage: "Tax",
    who: ["accountant", "reviewer", "firm_manager"],
    summary:
      "Approved computations fill a form workpaper line by line, with supporting schedules. A different accountant signs it off.",
    happens: [
      "A form definition is entered from the official form, verified with examples and enabled by a manager.",
      "An accountant prepares the workpaper for a client and period; manual lines and overrides need a reason.",
      "A reviewer signs it off with a statement of what was checked.",
    ],
    safeguards: [
      "Workpapers are never edited; preparing again supersedes the earlier one, which is kept.",
      "Errors in the form's own validations block sign-off.",
    ],
    links: [
      { route: "tax_forms", label: "Tax forms registry" },
      { route: "staff.tax", label: "Tax", scope: "staff" },
    ],
  },
  {
    id: "files",
    title: "10. Electronic files (DAT, alphalists)",
    stage: "Tax",
    who: ["accountant", "reviewer", "firm_manager"],
    summary:
      "Electronic files are generated from posted data using a layout transcribed from the official specification. A file is only valid after the official validation tool passes for that exact file.",
    happens: [
      "The firm enters the layout from the official specification, checks it against examples and enables it.",
      "An accountant generates the file; the system keeps a snapshot of the source rows and the file's fingerprint.",
      "The official validation module is run on the downloaded file and its result recorded; a reviewer signs the file off.",
    ],
    safeguards: [
      "A successful export is not enough: the official check must pass for the exact file (same fingerprint) and our own validation and reconciliation must pass too.",
      "No layout is built in or guessed; there are none until the firm adds them.",
    ],
    links: [
      { route: "eoutputs", label: "Electronic outputs & e-invoicing" },
      { route: "staff.tax", label: "Tax", scope: "staff" },
    ],
  },
  {
    id: "filing",
    title: "11. Filing a return",
    stage: "File",
    who: ["accountant", "reviewer", "firm_manager", "client_owner"],
    summary:
      "Each return moves through separate steps, each with who and when: prepared, reviewed, approved, exported, and filed.",
    happens: [
      "The preparer marks the return prepared (linking its workpaper) and submits it for review.",
      "A reviewer approves it (or returns it with a note).",
      "The export is recorded (the validated file, or entry in the official form tool).",
      "After actually submitting it to the BIR, someone confirms the filing with the date, channel, confirmation number and where the proof is kept. The client is told it was filed.",
    ],
    safeguards: [
      "A return is never marked filed just because a file was generated or downloaded.",
      "A filed return is frozen. Corrections are amended returns; a wrong confirmation is withdrawn only by an approved exception.",
    ],
    links: [
      { route: "staff.operations", label: "Operations (filing calendar)", scope: "staff" },
      { route: "calendar", label: "Filing calendar" },
    ],
  },
  {
    id: "operations",
    title: "12. Running the firm day to day",
    stage: "Run the firm",
    who: [...STAFF, "firm_admin"],
    summary:
      "Work queues, deadlines, reminders and reports keep everyone accountable for what is due and who has it.",
    happens: [
      "My work queue shows what waits on you: items to prepare or review, client responses, unassigned and overdue work.",
      "Deadline rules (entered and verified by the firm) build each client's filing calendar; reminders go out before and after due dates.",
      "Notifications tell people when something is assigned, returned, approved or due. They never include amounts or other financial details.",
      "Exception requests (reopen a locked month, change a due date) need a different manager's approval.",
      "Activity reports show who did what and when, for managers, the client's reviewers and admins.",
    ],
    safeguards: [
      "Only managers reassign work, with a reason. When someone loses access, their open work is released and managers are told.",
      "Every sensitive action is recorded in the audit trail.",
    ],
    links: [
      { route: "work", label: "My work queue" },
      { route: "deadlines", label: "Deadline rules" },
      { route: "notifications", label: "Notifications" },
      { route: "review.exceptions", label: "Exception requests" },
      { route: "review.activity", label: "Activity reports" },
    ],
  },
];

export interface TourLink {
  href: string;
  label: string;
}
export interface TourStep extends Omit<TourStepDef, "links"> {
  links: TourLink[];
  mine: boolean;
}

/** The user's own tour roles (firm role and/or client roles). */
export function tourRolesOf(facts: AccessFacts): TourRole[] {
  const roles = new Set<TourRole>();
  if (facts.firmRole) roles.add(facts.firmRole);
  for (const m of facts.clientMemberships) roles.add(m.role);
  return [...roles];
}

/** Steps with only the links this user may open, and whether each step involves them. */
export function buildTour(facts: AccessFacts): TourStep[] {
  const mine = new Set(tourRolesOf(facts));
  const memberClient = facts.clientMemberships[0]?.clientId;
  const staffClient = facts.staffClientIds[0];
  return TOUR_STEPS.map((step) => ({
    ...step,
    mine: step.who.some((r) => mine.has(r)),
    links: step.links.flatMap((l) => {
      const clientId =
        l.scope === "member" ? memberClient : l.scope === "staff" ? staffClient : undefined;
      if (l.scope && !clientId) return [];
      const params = clientId ? { clientId } : {};
      return evaluateRoute(l.route, facts, params).allowed
        ? [{ href: pathFor(l.route, params), label: l.label }]
        : [];
    }),
  }));
}
