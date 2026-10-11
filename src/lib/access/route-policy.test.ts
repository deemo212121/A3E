import { describe, expect, it } from "vitest";

import {
  buildNavigation,
  clientPortalTabs,
  evaluateRoute,
  homeFor,
  matchRoute,
  pathFor,
  type AccessFacts,
  type RouteKey,
} from "./route-policy";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

const none: AccessFacts = { firmRole: null, clientMemberships: [], staffClientIds: [] };
const m = (clientId: string, role: "client_owner" | "client_staff" | "client_viewer") => ({
  clientId,
  role,
  displayName: clientId === A ? "Client A" : "Client B",
  code: clientId === A ? "A" : "B",
});

export const PERSONAS: Record<string, AccessFacts> = {
  outsider: none,
  ownerA: { ...none, clientMemberships: [m(A, "client_owner")] },
  staffA: { ...none, clientMemberships: [m(A, "client_staff")] },
  viewerA: { ...none, clientMemberships: [m(A, "client_viewer")] },
  ownerAandB: { ...none, clientMemberships: [m(A, "client_owner"), m(B, "client_viewer")] },
  firmAdmin: { ...none, firmRole: "firm_admin" },
  manager: { ...none, firmRole: "firm_manager", staffClientIds: [A, B] },
  reviewerA: { ...none, firmRole: "reviewer", staffClientIds: [A], payrollClientIds: [A] },
  accountantB: { ...none, firmRole: "accountant", staffClientIds: [B] },
  bookkeeperNone: { ...none, firmRole: "bookkeeper" },
};

/** Expected access matrix (✓ = allowed). Client-scoped routes use client A. */
const EXPECTED: Record<string, RouteKey[]> = {
  outsider: ["home", "account", "invitations"],
  ownerA: [
    "home",
    "account",
    "invitations",
    "portal",
    "portal.client",
    "portal.contacts",
    "portal.team",
    "portal.documents",
    "portal.requests",
    "portal.transactions",
    "portal.transaction_new",
    "portal.transaction",
    "portal.counterparties",
    "portal.profile",
    "portal.imports",
    "portal.import",
  ],
  staffA: [
    "home",
    "account",
    "invitations",
    "portal",
    "portal.client",
    "portal.contacts",
    "portal.team",
    "portal.documents",
    "portal.requests",
    "portal.transactions",
    "portal.transaction_new",
    "portal.transaction",
    "portal.counterparties",
    "portal.profile",
    "portal.imports",
    "portal.import",
  ],
  viewerA: [
    "home",
    "account",
    "invitations",
    "portal",
    "portal.client",
    "portal.contacts",
    "portal.team",
    "portal.documents",
    "portal.requests",
    "portal.transactions",
    "portal.transaction",
    "portal.counterparties",
    "portal.profile",
    "portal.imports",
    "portal.import",
  ],
  firmAdmin: [
    "home",
    "account",
    "invitations",
    "admin",
    "admin.clients",
    "admin.client",
    "admin.users",
    "admin.invitations",
  ],
  manager: [
    "home",
    "account",
    "invitations",
    "staff",
    "staff.client",
    "staff.accounts",
    "staff.periods",
    "staff.journal",
    "staff.entry",
    "staff.trial_balance",
    "staff.ledger",
    "staff.intake",
    "staff.intake_txn",
    "staff.imports",
    "staff.import",
    "staff.sales",
    "staff.sales_invoice_new",
    "staff.sales_invoice",
    "staff.sales_receipt_new",
    "staff.sales_receipt",
    "staff.purchases",
    "staff.purchase_bill_new",
    "staff.purchase_bill",
    "staff.supplier_payment_new",
    "staff.supplier_payment",
    "staff.inventory",
    "staff.inventory_movement_new",
    "staff.inventory_movement",
    "staff.payroll",
    "review",
    "review.assignments",
    "admin",
    "admin.clients",
    "admin.client",
    "admin.invitations",
  ],
  reviewerA: [
    "home",
    "account",
    "invitations",
    "staff",
    "staff.client",
    "staff.accounts",
    "staff.periods",
    "staff.journal",
    "staff.entry",
    "staff.trial_balance",
    "staff.ledger",
    "staff.intake",
    "staff.intake_txn",
    "staff.imports",
    "staff.import",
    "staff.sales",
    "staff.sales_invoice_new",
    "staff.sales_invoice",
    "staff.sales_receipt_new",
    "staff.sales_receipt",
    "staff.purchases",
    "staff.purchase_bill_new",
    "staff.purchase_bill",
    "staff.supplier_payment_new",
    "staff.supplier_payment",
    "staff.inventory",
    "staff.inventory_movement_new",
    "staff.inventory_movement",
    "staff.payroll",
    "staff.payroll_run",
    "staff.payroll_employee",
    "staff.payslip",
    "review",
  ],
  accountantB: ["home", "account", "invitations", "staff"],
  bookkeeperNone: ["home", "account", "invitations", "staff"],
};

const ALL_ROUTES: RouteKey[] = [
  "home",
  "account",
  "invitations",
  "portal",
  "portal.client",
  "portal.contacts",
  "portal.team",
  "portal.documents",
  "portal.requests",
  "portal.transactions",
  "portal.transaction_new",
  "portal.transaction",
  "portal.counterparties",
  "portal.profile",
  "portal.imports",
  "portal.import",
  "staff",
  "staff.client",
  "staff.accounts",
  "staff.periods",
  "staff.journal",
  "staff.entry",
  "staff.trial_balance",
  "staff.ledger",
  "staff.intake",
  "staff.intake_txn",
  "staff.imports",
  "staff.import",
  "staff.sales",
  "staff.sales_invoice_new",
  "staff.sales_invoice",
  "staff.sales_receipt_new",
  "staff.sales_receipt",
  "staff.purchases",
  "staff.purchase_bill_new",
  "staff.purchase_bill",
  "staff.supplier_payment_new",
  "staff.supplier_payment",
  "staff.inventory",
  "staff.inventory_movement_new",
  "staff.inventory_movement",
  "staff.payroll",
  "staff.payroll_run",
  "staff.payroll_employee",
  "staff.payslip",
  "review",
  "review.assignments",
  "admin",
  "admin.clients",
  "admin.client",
  "admin.users",
  "admin.invitations",
];

describe("payroll is by explicit grant", () => {
  it("assigned staff without a payroll grant cannot open payroll pages", () => {
    const noGrant: AccessFacts = { ...PERSONAS.reviewerA, payrollClientIds: [] };
    for (const r of ["staff.payroll", "staff.payroll_run", "staff.payslip"] as const) {
      expect(evaluateRoute(r, noGrant, { clientId: A }).allowed).toBe(false);
    }
    // a grant for another client does not help
    const elsewhere: AccessFacts = { ...PERSONAS.reviewerA, payrollClientIds: [B] };
    expect(evaluateRoute("staff.payroll", elsewhere, { clientId: A }).allowed).toBe(false);
    // managers can open the overview (to grant access) but not payslips
    expect(evaluateRoute("staff.payslip", PERSONAS.manager, { clientId: A }).allowed).toBe(false);
  });
});

describe("access matrix", () => {
  for (const [persona, allowed] of Object.entries(EXPECTED)) {
    it(`${persona}: exactly the expected routes are allowed (client A context)`, () => {
      const facts = PERSONAS[persona];
      const actual = ALL_ROUTES.filter((r) => evaluateRoute(r, facts, { clientId: A }).allowed);
      expect(actual.sort()).toEqual([...allowed].sort());
    });
  }

  it("client users can never open another client's portal pages", () => {
    for (const persona of ["ownerA", "staffA", "viewerA"]) {
      for (const r of ["portal.client", "portal.contacts", "portal.team"] as const) {
        expect(evaluateRoute(r, PERSONAS[persona], { clientId: B })).toEqual({
          allowed: false,
          reason: "not_found",
        });
      }
    }
  });

  it("staff can open only assigned clients; unassigned looks like not-found", () => {
    expect(evaluateRoute("staff.client", PERSONAS.accountantB, { clientId: A })).toEqual({
      allowed: false,
      reason: "not_found",
    });
    expect(evaluateRoute("staff.client", PERSONAS.accountantB, { clientId: B }).allowed).toBe(true);
    expect(evaluateRoute("staff.client", PERSONAS.ownerA, { clientId: A })).toEqual({
      allowed: false,
      reason: "forbidden",
    });
  });

  it("firm admin has no route into client business records (SoD-5)", () => {
    for (const r of ["staff.client", "portal.client", "portal.contacts"] as const) {
      expect(evaluateRoute(r, PERSONAS.firmAdmin, { clientId: A }).allowed).toBe(false);
    }
  });
});

describe("navigation is consistent with the policy", () => {
  for (const [persona, facts] of Object.entries(PERSONAS)) {
    it(`${persona}: every visible nav item is an allowed route`, () => {
      for (const section of buildNavigation(facts)) {
        for (const navItem of section.items) {
          const matched = matchRoute(navItem.href);
          expect(matched, navItem.href).not.toBeNull();
          expect(evaluateRoute(matched!.route, facts, matched!.params).allowed).toBe(true);
        }
      }
      for (const membership of facts.clientMemberships) {
        for (const tab of clientPortalTabs(facts, membership.clientId)) {
          const matched = matchRoute(tab.href)!;
          expect(evaluateRoute(matched.route, facts, matched.params).allowed).toBe(true);
        }
      }
    });

    it(`${persona}: every allowed top-level area appears in the navigation`, () => {
      const hrefs = new Set(buildNavigation(facts).flatMap((s) => s.items.map((i) => i.href)));
      const topLevel: RouteKey[] = [
        "portal",
        "staff",
        "review",
        "review.assignments",
        "admin",
        "admin.clients",
        "admin.users",
        "admin.invitations",
        "account",
        "invitations",
      ];
      for (const r of topLevel) {
        if (evaluateRoute(r, facts).allowed) expect(hrefs.has(pathFor(r)), r).toBe(true);
      }
    });

    it(`${persona}: the home page is an allowed route`, () => {
      const matched = matchRoute(homeFor(facts))!;
      expect(evaluateRoute(matched.route, facts, matched.params).allowed).toBe(true);
    });
  }
});

describe("matchRoute", () => {
  it("round-trips every route through pathFor", () => {
    const E = "eeeeeeee-0000-4000-8000-00000000000e";
    for (const r of ALL_ROUTES) {
      const href = pathFor(r, { clientId: A, entryId: E, itemId: E });
      const params: Record<string, string> = {};
      if (href.includes(A)) params.clientId = A;
      if (href.includes(E)) params[r === "staff.entry" ? "entryId" : "itemId"] = E;
      expect(matchRoute(href)).toEqual({ route: r, params });
    }
  });

  it("staff ledger routes are not_found for unassigned clients and forbidden for client users", () => {
    for (const r of [
      "staff.journal",
      "staff.entry",
      "staff.trial_balance",
      "staff.accounts",
    ] as const) {
      expect(evaluateRoute(r, PERSONAS.accountantB, { clientId: A })).toEqual({
        allowed: false,
        reason: "not_found",
      });
      expect(evaluateRoute(r, PERSONAS.ownerA, { clientId: A })).toEqual({
        allowed: false,
        reason: "forbidden",
      });
    }
  });

  it("client viewers can read intake pages but not open the new-transaction form", () => {
    expect(evaluateRoute("portal.transactions", PERSONAS.viewerA, { clientId: A }).allowed).toBe(
      true,
    );
    expect(evaluateRoute("portal.transaction_new", PERSONAS.viewerA, { clientId: A })).toEqual({
      allowed: false,
      reason: "forbidden",
    });
    expect(evaluateRoute("portal.transaction_new", PERSONAS.ownerA, { clientId: B })).toEqual({
      allowed: false,
      reason: "not_found",
    });
  });

  it("a non-UUID item id never matches (e.g. 'new' is its own route)", () => {
    expect(matchRoute(`/portal/${A}/transactions/new`)?.route).toBe("portal.transaction_new");
    expect(matchRoute(`/portal/${A}/transactions/xyz`)).toBeNull();
    expect(matchRoute(`/staff/clients/${A}/imports/../journal`)).toBeNull();
  });

  it("rejects malformed ids and unknown paths", () => {
    expect(matchRoute("/portal/not-a-uuid")).toBeNull();
    expect(matchRoute("/admin/secret")).toBeNull();
    expect(matchRoute("/portal/../admin")).toBeNull();
  });
});
