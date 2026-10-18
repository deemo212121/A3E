/**
 * Guided tour over the tour sandbox client (sample data created by
 * public.tour_seed_sandbox). Each step names the real page to open for the
 * user's kind of access, the section to highlight, what to look at, and what
 * to try. Paths go through the route policy, so a step never sends someone to
 * a page they may not open.
 */
import { evaluateRoute, pathFor, type AccessFacts, type RouteKey } from "@/lib/access/route-policy";

export interface GuidedStep {
  id: string;
  title: string;
  /** Page to open (null when this user has no page for the step). */
  path: string | null;
  /** Section heading on that page to highlight (prefix match). */
  focus: string | null;
  text: string;
  tryIt: string | null;
}

interface View {
  route: RouteKey;
  client?: boolean;
  focus?: string;
  text: string;
  tryIt?: string;
}
interface GuidedDef {
  id: string;
  title: string;
  /** Tried in order: the first page this user may open is used. */
  views: View[];
  /** Shown when no view is available to this user. */
  otherwise: string;
}

const DEFS: GuidedDef[] = [
  {
    id: "welcome",
    title: "Welcome to DEMO Tour Sample Co.",
    views: [
      {
        route: "staff.client",
        client: true,
        focus: "Assigned firm staff",
        text: "This sample client was set up the way a real one is: a manager created it and assigned a reviewer and an accountant; the client owner was invited. Everything you will see was done through the real workflow, by the right person.",
      },
      {
        route: "portal.client",
        client: true,
        focus: "At a glance",
        text: "This is the sample business's portal, as its owner sees it. Your accountant set it up and invited you.",
      },
    ],
    otherwise: "Sign in as a firm user or the demo client owner to see the sample client.",
  },
  {
    id: "submit",
    title: "The client sends in records",
    views: [
      {
        route: "portal.transactions",
        client: true,
        text: "The owner recorded three transactions. SI-TOUR-0001 is already posted, SI-TOUR-0002 was approved, and OR-SUP-0101 (a purchase) is waiting for the accountant's review.",
        tryIt:
          "Record a new transaction with the New transaction button and submit it. Pressing submit twice still records it once.",
      },
      {
        route: "staff.intake",
        client: true,
        text: "Client submissions arrive here. OR-SUP-0101 (a purchase from Tour Office Supplies) is waiting for review.",
        tryIt:
          "Accountant: open OR-SUP-0101 and mark it Reviewed (or return it with a note). A reviewer then approves it.",
      },
    ],
    otherwise: "Clients submit their sales, purchases and expenses with their receipts.",
  },
  {
    id: "review",
    title: "Review and approval (maker-checker)",
    views: [
      {
        route: "review",
        focus: "Awaiting review",
        text: "Everything waiting for a reviewer across your clients: the Electricity bill entry and the SI-TOUR-0002 invoice were prepared by the accountant.",
        tryIt:
          "Reviewer or manager: open the Electricity bill entry and Approve & post it. You can never approve something you prepared yourself.",
      },
      {
        route: "staff.journal",
        client: true,
        focus: "Entries",
        text: "Your entries and their status. The Electricity bill entry is submitted and waits for a reviewer: the person who prepares an entry can never approve it.",
      },
    ],
    otherwise: "The firm reviews each submission; a second person approves it.",
  },
  {
    id: "sales",
    title: "Sales, receipts and receivables",
    views: [
      {
        route: "staff.sales",
        client: true,
        focus: "Ledger reconciliation",
        text: "SI-TOUR-0001 (11,200.00 including VAT) was posted last month and half paid by OR-TOUR-0001. The receivables subledger equals the ledger: the reconciliation difference is zero. The aging shows the unpaid half.",
        tryIt:
          "Reviewer: post SI-TOUR-0002 from its page, then watch the reconciliation stay at zero.",
      },
    ],
    otherwise: "Invoices and receipts are recorded and posted by the firm.",
  },
  {
    id: "ledger",
    title: "Books that always balance",
    views: [
      {
        route: "staff.trial_balance",
        client: true,
        focus: "Trial balance as of",
        text: "Every posted entry balances (the database refuses one that does not), so total debits always equal total credits. Posted entries can never be edited; a mistake is corrected with a reversal.",
      },
    ],
    otherwise: "Posted entries always balance and are never edited; corrections are reversals.",
  },
  {
    id: "statements",
    title: "Financial statements",
    views: [
      {
        route: "staff.reports",
        client: true,
        text: "Income statement, balance sheet and cash flow straight from the posted entries. Click any figure to drill down to its entries.",
      },
      {
        route: "portal.reports",
        client: true,
        text: "Last month was reviewed and closed, so its statements are now visible to you. Months still being worked on stay hidden from clients.",
      },
    ],
    otherwise: "Statements come straight from posted entries.",
  },
  {
    id: "tax",
    title: "Tax computation, workpaper and file",
    views: [
      {
        route: "staff.tax",
        client: true,
        focus: "Computations",
        text: "Last month's TOUR_SAMPLE_TAX (a TOUR ONLY synthetic 10% rule, not a BIR rule) computed 1,000.00 from the ledger and was reviewed by a second person. The TOUR_FORM workpaper was signed off, and the TOUR_SLS file was generated, validated for that exact file and signed off.",
        tryIt:
          "Open the computation to see each input traced to its ledger lines, or the file to see its validation and fingerprint.",
      },
    ],
    otherwise: "The firm computes taxes from the books with rules it has verified.",
  },
  {
    id: "registries",
    title: "Where tax rules come from",
    views: [
      {
        route: "tax_rules",
        focus: "Rules",
        text: "No real rule ships with the platform. The TOUR ONLY sample rule shows the gates every real rule passes: a cited source, worked examples checked by a second accountant, and approval by another person.",
      },
    ],
    otherwise:
      "Each tax rule is entered by the firm's accountant with its official source and approved by another person.",
  },
  {
    id: "filing",
    title: "Filing the return",
    views: [
      {
        route: "staff.operations",
        client: true,
        focus: "Filing calendar",
        text: "Last month's TOUR_FORM return was prepared, reviewed and approved. It is NOT filed yet: filing needs the export and an actual filing confirmation.",
        tryIt:
          "Open the approved TOUR_FORM filing, Record export (choose the validated electronic output), then Confirm actual filing with a date, a reference and where the proof is kept.",
      },
      {
        route: "portal.requests",
        client: true,
        focus: "Waiting for you",
        text: "Your accountant asked for this month's bank statement.",
        tryIt:
          "Upload a file on the Documents page, then come back and attach it here (or explain why there is none).",
      },
    ],
    otherwise: "Returns move through prepared, reviewed, approved, exported and filed.",
  },
  {
    id: "work",
    title: "Your work queue",
    views: [
      {
        route: "work",
        text: "What waits on you across your clients: items to prepare or review, client responses, unassigned and overdue work.",
        tryIt: "Open 'Reconcile the bank account (tour sample)' and move it to review.",
      },
      {
        route: "notifications",
        focus: "Inbox",
        text: "Notifications tell you when something needs you. They never include amounts or other financial details.",
      },
    ],
    otherwise: "Work queues and notifications keep everyone on track.",
  },
  {
    id: "finish",
    title: "That's the whole process",
    views: [
      {
        route: "tour",
        text: "You have seen a client's records go all the way to a filed return. The sample data stays until you remove it on this page.",
      },
    ],
    otherwise: "",
  },
];

export function buildGuidedTour(facts: AccessFacts, sandboxClientId: string): GuidedStep[] {
  return DEFS.map((d) => {
    for (const v of d.views) {
      const params = v.client ? { clientId: sandboxClientId } : {};
      if (evaluateRoute(v.route, facts, params).allowed)
        return {
          id: d.id,
          title: d.title,
          path: pathFor(v.route, params),
          focus: v.focus ?? null,
          text: v.text,
          tryIt: v.tryIt ?? null,
        };
    }
    return { id: d.id, title: d.title, path: null, focus: null, text: d.otherwise, tryIt: null };
  });
}
