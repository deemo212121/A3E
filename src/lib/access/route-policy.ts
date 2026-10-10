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
  | "staff"
  | "staff.client"
  | "staff.accounts"
  | "staff.periods"
  | "staff.journal"
  | "staff.entry"
  | "staff.trial_balance"
  | "staff.ledger"
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
      return membership(facts, params.clientId) ? ALLOW : NOT_FOUND;

    case "staff":
      return hasRole(facts, STAFF_ROLES) ? ALLOW : FORBIDDEN;
    case "staff.client":
    case "staff.accounts":
    case "staff.periods":
    case "staff.journal":
    case "staff.entry":
    case "staff.trial_balance":
    case "staff.ledger":
      if (!hasRole(facts, STAFF_ROLES)) return FORBIDDEN;
      return params.clientId && facts.staffClientIds.includes(params.clientId) ? ALLOW : NOT_FOUND;

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
const MATCHERS: [RegExp, RouteKey][] = [
  [/^\/app$/, "home"],
  [/^\/account$/, "account"],
  [/^\/invitations$/, "invitations"],
  [/^\/portal$/, "portal"],
  [new RegExp(`^/portal/(${UUID})$`), "portal.client"],
  [new RegExp(`^/portal/(${UUID})/contacts$`), "portal.contacts"],
  [new RegExp(`^/portal/(${UUID})/team$`), "portal.team"],
  [new RegExp(`^/portal/(${UUID})/documents$`), "portal.documents"],
  [new RegExp(`^/portal/(${UUID})/requests$`), "portal.requests"],
  [/^\/staff$/, "staff"],
  [new RegExp(`${STAFF_CLIENT}$`), "staff.client"],
  [new RegExp(`${STAFF_CLIENT}/accounts$`), "staff.accounts"],
  [new RegExp(`${STAFF_CLIENT}/periods$`), "staff.periods"],
  [new RegExp(`${STAFF_CLIENT}/journal$`), "staff.journal"],
  [new RegExp(`${STAFF_CLIENT}/journal/(${UUID})$`), "staff.entry"],
  [new RegExp(`${STAFF_CLIENT}/trial-balance$`), "staff.trial_balance"],
  [new RegExp(`${STAFF_CLIENT}/ledger$`), "staff.ledger"],
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
  for (const [re, route] of MATCHERS) {
    const m = re.exec(pathname);
    if (m) {
      const params: RouteParams = {};
      if (m[1]) params.clientId = m[1].toLowerCase();
      if (m[2]) params.entryId = m[2].toLowerCase();
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
    ...item(facts, "portal.contacts", "Contacts", { clientId }),
    ...item(facts, "portal.team", "Team", { clientId }),
    ...item(facts, "portal.documents", "Documents", { clientId }),
    ...item(facts, "portal.requests", "Requests", { clientId }),
  ];
}

/** Tabs inside a staff client workspace, filtered by the same policy. */
export function staffClientTabs(facts: AccessFacts, clientId: string): NavItem[] {
  return [
    ...item(facts, "staff.client", "Overview", { clientId }),
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
