/**
 * Route access policy: the SINGLE source of truth for which routes a user may
 * open. Used by:
 *   - server-side route guards (src/server/auth/route-guard.ts), and
 *   - navigation rendering (buildNavigation),
 * so the menu can never show a route the server would refuse, and vice versa.
 *
 * Navigation visibility is NOT authorization: guards re-evaluate this policy on
 * every request (direct URL, reload, new tab), and RLS protects the data.
 *
 * Pure module: no I/O, safe to unit-test and to import anywhere.
 */

export const FIRM_ROLES = [
  "firm_admin",
  "firm_manager",
  "reviewer",
  "accountant",
  "bookkeeper",
] as const;
export const CLIENT_ROLES = ["client_owner", "client_staff", "client_viewer"] as const;
export type FirmRole = (typeof FIRM_ROLES)[number];
export type ClientRole = (typeof CLIENT_ROLES)[number];

export const STAFF_ROLES: readonly FirmRole[] = [
  "firm_manager",
  "reviewer",
  "accountant",
  "bookkeeper",
];
export const REVIEW_ROLES: readonly FirmRole[] = ["firm_manager", "reviewer"];
export const ADMIN_AREA_ROLES: readonly FirmRole[] = ["firm_admin", "firm_manager"];

/** Facts about the signed-in user, loaded from the database. */
export interface AccessFacts {
  /** Effective firm role (null without one, or when staff MFA is not satisfied). */
  firmRole: FirmRole | null;
  clientMemberships: readonly {
    clientId: string;
    role: ClientRole;
    displayName: string;
    code: string;
  }[];
  /** Clients a staff member may work on (all, for managers). */
  staffClientIds: readonly string[];
  /** Clients whose payroll the user holds an explicit grant for. */
  payrollClientIds?: readonly string[];
}

export type RouteKey =
  | "home"
  | "account"
  | "invitations"
  | "portal"
  | "portal.client"
  | "portal.contacts"
  | "portal.team"
  | "portal.documents"
  | "portal.requests"
  | "portal.transactions"
  | "portal.transaction_new"
  | "portal.transaction"
  | "portal.counterparties"
  | "portal.profile"
  | "portal.imports"
  | "portal.import"
  | "staff"
  | "staff.client"
  | "staff.accounts"
  | "staff.periods"
  | "staff.journal"
  | "staff.entry"
  | "staff.trial_balance"
  | "staff.ledger"
  | "staff.intake"
  | "staff.intake_txn"
  | "staff.imports"
  | "staff.import"
  | "staff.sales"
  | "staff.sales_invoice_new"
  | "staff.sales_invoice"
  | "staff.sales_receipt_new"
  | "staff.sales_receipt"
  | "staff.purchases"
  | "staff.purchase_bill_new"
  | "staff.purchase_bill"
  | "staff.supplier_payment_new"
  | "staff.supplier_payment"
  | "staff.inventory"
  | "staff.inventory_movement_new"
  | "staff.inventory_movement"
  | "staff.payroll"
  | "staff.payroll_run"
  | "staff.payroll_employee"
  | "staff.payslip"
  | "review"
  | "review.assignments"
  | "admin"
  | "admin.clients"
  | "admin.client"
  | "admin.users"
  | "admin.invitations";

export interface RouteParams {
  clientId?: string;
  /** Journal entry id (existence and ownership are checked under RLS by the page). */
  entryId?: string;
  /** Intake transaction or import batch id (checked under RLS by the page). */
  itemId?: string;
}

export type Decision = { allowed: true } | { allowed: false; reason: "forbidden" | "not_found" };

const ALLOW: Decision = { allowed: true };
const FORBIDDEN: Decision = { allowed: false, reason: "forbidden" };
/** Used for client-scoped routes so a client's existence is never revealed. */
const NOT_FOUND: Decision = { allowed: false, reason: "not_found" };

function hasRole(facts: AccessFacts, roles: readonly FirmRole[]): boolean {
  return facts.firmRole !== null && roles.includes(facts.firmRole);
}

function membership(facts: AccessFacts, clientId: string | undefined) {
  return clientId ? facts.clientMemberships.find((m) => m.clientId === clientId) : undefined;
}

export function evaluateRoute(
  route: RouteKey,
  facts: AccessFacts,
  params: RouteParams = {},
): Decision {
  switch (route) {
    case "home":
    case "account":
    case "invitations":
      return ALLOW;

    case "portal":
      return facts.clientMemberships.length > 0 ? ALLOW : FORBIDDEN;
    case "portal.client":
    case "portal.contacts":
    case "portal.team":
    case "portal.documents":
    case "portal.requests":
    case "portal.transactions":
    case "portal.transaction":
    case "portal.counterparties":
    case "portal.profile":
    case "portal.imports":
    case "portal.import":
      return membership(facts, params.clientId) ? ALLOW : NOT_FOUND;
    case "portal.transaction_new": {
      // Viewers may read but not record transactions.
      const m = membership(facts, params.clientId);
      if (!m) return NOT_FOUND;
      return m.role === "client_viewer" ? FORBIDDEN : ALLOW;
    }

    case "staff":
      return hasRole(facts, STAFF_ROLES) ? ALLOW : FORBIDDEN;
    case "staff.client":
    case "staff.accounts":
    case "staff.periods":
    case "staff.journal":
    case "staff.entry":
    case "staff.trial_balance":
    case "staff.ledger":
    case "staff.intake":
    case "staff.intake_txn":
    case "staff.imports":
    case "staff.import":
    case "staff.sales":
    case "staff.sales_invoice_new":
    case "staff.sales_invoice":
    case "staff.sales_receipt_new":
    case "staff.sales_receipt":
    case "staff.purchases":
    case "staff.purchase_bill_new":
    case "staff.purchase_bill":
    case "staff.supplier_payment_new":
    case "staff.supplier_payment":
    case "staff.inventory":
    case "staff.inventory_movement_new":
    case "staff.inventory_movement":
      if (!hasRole(facts, STAFF_ROLES)) return FORBIDDEN;
      return params.clientId && facts.staffClientIds.includes(params.clientId) ? ALLOW : NOT_FOUND;

    // Payroll: assigned staff WITH an explicit payroll grant (managers may
    // open the overview to manage grants). Everyone else: not found.
    case "staff.payroll":
    case "staff.payroll_run":
    case "staff.payroll_employee":
    case "staff.payslip": {
      if (!hasRole(facts, STAFF_ROLES)) return FORBIDDEN;
      const id = params.clientId;
      if (!id || !facts.staffClientIds.includes(id)) return NOT_FOUND;
      if ((facts.payrollClientIds ?? []).includes(id)) return ALLOW;
      return route === "staff.payroll" && facts.firmRole === "firm_manager" ? ALLOW : NOT_FOUND;
    }

    case "review":
      return hasRole(facts, REVIEW_ROLES) ? ALLOW : FORBIDDEN;
    case "review.assignments":
      return hasRole(facts, ["firm_manager"]) ? ALLOW : FORBIDDEN;

    case "admin":
    case "admin.clients":
    case "admin.invitations":
      return hasRole(facts, ADMIN_AREA_ROLES) ? ALLOW : FORBIDDEN;
    case "admin.client":
      // Existence of the client is checked against the database by the page.
      return hasRole(facts, ADMIN_AREA_ROLES) ? ALLOW : FORBIDDEN;
    case "admin.users":
      return hasRole(facts, ["firm_admin"]) ? ALLOW : FORBIDDEN;
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
export function pathFor(route: RouteKey, params: RouteParams = {}): string {
  const id = params.clientId ?? ":clientId";
  const entry = params.entryId ?? ":entryId";
  const item = params.itemId ?? ":itemId";
  switch (route) {
    case "home":
      return "/app";
    case "account":
      return "/account";
    case "invitations":
      return "/invitations";
    case "portal":
      return "/portal";
    case "portal.client":
      return `/portal/${id}`;
    case "portal.contacts":
      return `/portal/${id}/contacts`;
    case "portal.team":
      return `/portal/${id}/team`;
    case "portal.documents":
      return `/portal/${id}/documents`;
    case "portal.requests":
      return `/portal/${id}/requests`;
    case "portal.transactions":
      return `/portal/${id}/transactions`;
    case "portal.transaction_new":
      return `/portal/${id}/transactions/new`;
    case "portal.transaction":
      return `/portal/${id}/transactions/${item}`;
    case "portal.counterparties":
      return `/portal/${id}/counterparties`;
    case "portal.profile":
      return `/portal/${id}/profile`;
    case "portal.imports":
      return `/portal/${id}/imports`;
    case "portal.import":
      return `/portal/${id}/imports/${item}`;
    case "staff":
      return "/staff";
    case "staff.client":
      return `/staff/clients/${id}`;
    case "staff.accounts":
      return `/staff/clients/${id}/accounts`;
    case "staff.periods":
      return `/staff/clients/${id}/periods`;
    case "staff.journal":
      return `/staff/clients/${id}/journal`;
    case "staff.entry":
      return `/staff/clients/${id}/journal/${entry}`;
    case "staff.trial_balance":
      return `/staff/clients/${id}/trial-balance`;
    case "staff.ledger":
      return `/staff/clients/${id}/ledger`;
    case "staff.intake":
      return `/staff/clients/${id}/intake`;
    case "staff.intake_txn":
      return `/staff/clients/${id}/intake/${item}`;
    case "staff.imports":
      return `/staff/clients/${id}/imports`;
    case "staff.import":
      return `/staff/clients/${id}/imports/${item}`;
    case "staff.sales":
      return `/staff/clients/${id}/sales`;
    case "staff.sales_invoice_new":
      return `/staff/clients/${id}/sales/invoices/new`;
    case "staff.sales_invoice":
      return `/staff/clients/${id}/sales/invoices/${item}`;
    case "staff.sales_receipt_new":
      return `/staff/clients/${id}/sales/receipts/new`;
    case "staff.sales_receipt":
      return `/staff/clients/${id}/sales/receipts/${item}`;
    case "staff.purchases":
      return `/staff/clients/${id}/purchases`;
    case "staff.purchase_bill_new":
      return `/staff/clients/${id}/purchases/bills/new`;
    case "staff.purchase_bill":
      return `/staff/clients/${id}/purchases/bills/${item}`;
    case "staff.supplier_payment_new":
      return `/staff/clients/${id}/purchases/payments/new`;
    case "staff.supplier_payment":
      return `/staff/clients/${id}/purchases/payments/${item}`;
    case "staff.inventory":
      return `/staff/clients/${id}/inventory`;
    case "staff.inventory_movement_new":
      return `/staff/clients/${id}/inventory/movements/new`;
    case "staff.inventory_movement":
      return `/staff/clients/${id}/inventory/movements/${item}`;
    case "staff.payroll":
      return `/staff/clients/${id}/payroll`;
    case "staff.payroll_run":
      return `/staff/clients/${id}/payroll/runs/${item}`;
    case "staff.payroll_employee":
      return `/staff/clients/${id}/payroll/employees/${item}`;
    case "staff.payslip":
      return `/staff/clients/${id}/payroll/payslips/${item}`;
    case "review":
      return "/review";
    case "review.assignments":
      return "/review/assignments";
    case "admin":
      return "/admin";
    case "admin.clients":
      return "/admin/clients";
    case "admin.client":
      return `/admin/clients/${id}`;
    case "admin.users":
      return "/admin/users";
    case "admin.invitations":
      return "/admin/invitations";
  }
}

const UUID = "[0-9a-fA-F-]{36}";
const STAFF_CLIENT = `^/staff/clients/(${UUID})`;
type Matcher = [RegExp, RouteKey, ("entryId" | "itemId")?];
const MATCHERS: Matcher[] = [
  [/^\/app$/, "home"],
  [/^\/account$/, "account"],
  [/^\/invitations$/, "invitations"],
  [/^\/portal$/, "portal"],
  [new RegExp(`^/portal/(${UUID})$`), "portal.client"],
  [new RegExp(`^/portal/(${UUID})/contacts$`), "portal.contacts"],
  [new RegExp(`^/portal/(${UUID})/team$`), "portal.team"],
  [new RegExp(`^/portal/(${UUID})/documents$`), "portal.documents"],
  [new RegExp(`^/portal/(${UUID})/requests$`), "portal.requests"],
  [new RegExp(`^/portal/(${UUID})/transactions$`), "portal.transactions"],
  [new RegExp(`^/portal/(${UUID})/transactions/new$`), "portal.transaction_new"],
  [new RegExp(`^/portal/(${UUID})/transactions/(${UUID})$`), "portal.transaction", "itemId"],
  [new RegExp(`^/portal/(${UUID})/counterparties$`), "portal.counterparties"],
  [new RegExp(`^/portal/(${UUID})/profile$`), "portal.profile"],
  [new RegExp(`^/portal/(${UUID})/imports$`), "portal.imports"],
  [new RegExp(`^/portal/(${UUID})/imports/(${UUID})$`), "portal.import", "itemId"],
  [/^\/staff$/, "staff"],
  [new RegExp(`${STAFF_CLIENT}$`), "staff.client"],
  [new RegExp(`${STAFF_CLIENT}/accounts$`), "staff.accounts"],
  [new RegExp(`${STAFF_CLIENT}/periods$`), "staff.periods"],
  [new RegExp(`${STAFF_CLIENT}/journal$`), "staff.journal"],
  [new RegExp(`${STAFF_CLIENT}/journal/(${UUID})$`), "staff.entry", "entryId"],
  [new RegExp(`${STAFF_CLIENT}/trial-balance$`), "staff.trial_balance"],
  [new RegExp(`${STAFF_CLIENT}/ledger$`), "staff.ledger"],
  [new RegExp(`${STAFF_CLIENT}/intake$`), "staff.intake"],
  [new RegExp(`${STAFF_CLIENT}/intake/(${UUID})$`), "staff.intake_txn", "itemId"],
  [new RegExp(`${STAFF_CLIENT}/imports$`), "staff.imports"],
  [new RegExp(`${STAFF_CLIENT}/imports/(${UUID})$`), "staff.import", "itemId"],
  [new RegExp(`${STAFF_CLIENT}/sales$`), "staff.sales"],
  [new RegExp(`${STAFF_CLIENT}/sales/invoices/new$`), "staff.sales_invoice_new"],
  [new RegExp(`${STAFF_CLIENT}/sales/invoices/(${UUID})$`), "staff.sales_invoice", "itemId"],
  [new RegExp(`${STAFF_CLIENT}/sales/receipts/new$`), "staff.sales_receipt_new"],
  [new RegExp(`${STAFF_CLIENT}/sales/receipts/(${UUID})$`), "staff.sales_receipt", "itemId"],
  [new RegExp(`${STAFF_CLIENT}/purchases$`), "staff.purchases"],
  [new RegExp(`${STAFF_CLIENT}/purchases/bills/new$`), "staff.purchase_bill_new"],
  [new RegExp(`${STAFF_CLIENT}/purchases/bills/(${UUID})$`), "staff.purchase_bill", "itemId"],
  [new RegExp(`${STAFF_CLIENT}/purchases/payments/new$`), "staff.supplier_payment_new"],
  [new RegExp(`${STAFF_CLIENT}/purchases/payments/(${UUID})$`), "staff.supplier_payment", "itemId"],
  [new RegExp(`${STAFF_CLIENT}/inventory$`), "staff.inventory"],
  [new RegExp(`${STAFF_CLIENT}/inventory/movements/new$`), "staff.inventory_movement_new"],
  [
    new RegExp(`${STAFF_CLIENT}/inventory/movements/(${UUID})$`),
    "staff.inventory_movement",
    "itemId",
  ],
  [new RegExp(`${STAFF_CLIENT}/payroll$`), "staff.payroll"],
  [new RegExp(`${STAFF_CLIENT}/payroll/runs/(${UUID})$`), "staff.payroll_run", "itemId"],
  [new RegExp(`${STAFF_CLIENT}/payroll/employees/(${UUID})$`), "staff.payroll_employee", "itemId"],
  [new RegExp(`${STAFF_CLIENT}/payroll/payslips/(${UUID})$`), "staff.payslip", "itemId"],
  [/^\/review$/, "review"],
  [/^\/review\/assignments$/, "review.assignments"],
  [/^\/admin$/, "admin"],
  [/^\/admin\/clients$/, "admin.clients"],
  [new RegExp(`^/admin/clients/(${UUID})$`), "admin.client"],
  [/^\/admin\/users$/, "admin.users"],
  [/^\/admin\/invitations$/, "admin.invitations"],
];

/** Maps a pathname to its route (and params); null for unknown/public paths. */
export function matchRoute(pathname: string): { route: RouteKey; params: RouteParams } | null {
  for (const [re, route, second] of MATCHERS) {
    const m = re.exec(pathname);
    if (m) {
      const params: RouteParams = {};
      if (m[1]) params.clientId = m[1].toLowerCase();
      if (m[2] && second) params[second] = m[2].toLowerCase();
      return { route, params };
    }
  }
  return null;
}

/** Path prefixes that require a signed-in user (used by the proxy's optimistic check). */
export const PROTECTED_PREFIXES = [
  "/app",
  "/account",
  "/invitations",
  "/portal",
  "/staff",
  "/review",
  "/admin",
];

// ---------------------------------------------------------------------------
// Navigation (derived from the policy, never hand-maintained separately)
// ---------------------------------------------------------------------------
export interface NavItem {
  route: RouteKey;
  href: string;
  label: string;
}
export interface NavSection {
  id: "portal" | "staff" | "review" | "admin" | "account";
  label: string;
  items: NavItem[];
}

function item(
  facts: AccessFacts,
  route: RouteKey,
  label: string,
  params: RouteParams = {},
): NavItem[] {
  return evaluateRoute(route, facts, params).allowed
    ? [{ route, href: pathFor(route, params), label }]
    : [];
}

export function buildNavigation(facts: AccessFacts): NavSection[] {
  const sections: NavSection[] = [
    {
      id: "portal",
      label: "Client portal",
      items: [
        ...item(facts, "portal", "My businesses"),
        ...facts.clientMemberships.flatMap((m) =>
          item(facts, "portal.client", m.displayName, { clientId: m.clientId }),
        ),
      ],
    },
    { id: "staff", label: "Accounting staff", items: item(facts, "staff", "My clients") },
    {
      id: "review",
      label: "Review workspace",
      items: [
        ...item(facts, "review", "Review queue"),
        ...item(facts, "review.assignments", "Staff assignments"),
      ],
    },
    {
      id: "admin",
      label: "Firm administration",
      items: [
        ...item(facts, "admin", "Overview"),
        ...item(facts, "admin.clients", "Clients"),
        ...item(facts, "admin.users", "Users"),
        ...item(facts, "admin.invitations", "Invitations"),
      ],
    },
    {
      id: "account",
      label: "Account",
      items: [
        ...item(facts, "account", "My account"),
        ...item(facts, "invitations", "My invitations"),
      ],
    },
  ];
  return sections.filter((s) => s.items.length > 0);
}

/** Tabs inside a client's portal pages, filtered by the same policy. */
export function clientPortalTabs(facts: AccessFacts, clientId: string): NavItem[] {
  return [
    ...item(facts, "portal.client", "Overview", { clientId }),
    ...item(facts, "portal.transactions", "Transactions", { clientId }),
    ...item(facts, "portal.documents", "Documents", { clientId }),
    ...item(facts, "portal.imports", "Imports", { clientId }),
    ...item(facts, "portal.counterparties", "Customers & suppliers", { clientId }),
    ...item(facts, "portal.profile", "Business profile", { clientId }),
    ...item(facts, "portal.contacts", "Contacts", { clientId }),
    ...item(facts, "portal.team", "Team", { clientId }),
    ...item(facts, "portal.requests", "Requests", { clientId }),
  ];
}

/** Tabs inside a staff client workspace, filtered by the same policy. */
export function staffClientTabs(facts: AccessFacts, clientId: string): NavItem[] {
  return [
    ...item(facts, "staff.client", "Overview", { clientId }),
    ...item(facts, "staff.intake", "Intake", { clientId }),
    ...item(facts, "staff.imports", "Imports", { clientId }),
    ...item(facts, "staff.sales", "Sales & receivables", { clientId }),
    ...item(facts, "staff.purchases", "Purchases & payables", { clientId }),
    ...item(facts, "staff.inventory", "Inventory", { clientId }),
    ...item(facts, "staff.payroll", "Payroll", { clientId }),
    ...item(facts, "staff.journal", "Journal", { clientId }),
    ...item(facts, "staff.trial_balance", "Trial balance", { clientId }),
    ...item(facts, "staff.ledger", "General ledger", { clientId }),
    ...item(facts, "staff.accounts", "Chart of accounts", { clientId }),
    ...item(facts, "staff.periods", "Periods", { clientId }),
  ];
}

/** Default landing page after sign-in, by the user's primary role. */
export function homeFor(facts: AccessFacts): string {
  if (hasRole(facts, ["firm_admin"])) return pathFor("admin");
  if (hasRole(facts, REVIEW_ROLES)) return pathFor("review");
  if (hasRole(facts, STAFF_ROLES)) return pathFor("staff");
  if (facts.clientMemberships.length === 1) {
    return pathFor("portal.client", { clientId: facts.clientMemberships[0].clientId });
  }
  if (facts.clientMemberships.length > 1) return pathFor("portal");
  return pathFor("invitations");
}
