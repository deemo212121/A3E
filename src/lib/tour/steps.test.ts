import { describe, expect, it } from "vitest";

import { evaluateRoute, matchRoute } from "@/lib/access/route-policy";
import { PERSONAS } from "@/lib/access/personas.fixture";

import { buildTour, TOUR_STEPS } from "./steps";

describe("system tour", () => {
  it("covers the whole process in order, every step with roles, actions and safeguards", () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual([
      "invite",
      "profile",
      "submit",
      "review",
      "post",
      "close",
      "reports",
      "tax",
      "forms",
      "files",
      "filing",
      "operations",
    ]);
    for (const s of TOUR_STEPS) {
      expect(s.who.length, s.id).toBeGreaterThan(0);
      expect(s.happens.length, s.id).toBeGreaterThan(0);
      expect(s.safeguards.length, s.id).toBeGreaterThan(0);
    }
  });

  for (const [persona, facts] of Object.entries(PERSONAS)) {
    it(`${persona}: every tour link is a page they may open`, () => {
      for (const step of buildTour(facts))
        for (const link of step.links) {
          const m = matchRoute(link.href);
          expect(m, link.href).not.toBeNull();
          expect(evaluateRoute(m!.route, facts, m!.params).allowed, `${persona} ${link.href}`).toBe(
            true,
          );
        }
    });
  }

  it("marks the steps that involve the user's role", () => {
    const mine = (p: keyof typeof PERSONAS) =>
      buildTour(PERSONAS[p])
        .filter((s) => s.mine)
        .map((s) => s.id);
    expect(mine("viewerA")).toEqual(["reports"]);
    expect(mine("ownerA")).toEqual(["invite", "profile", "submit", "reports", "filing"]);
    expect(mine("reviewerA")).toContain("post");
    expect(mine("firmAdmin")).toEqual(["invite", "operations"]);
    expect(mine("outsider")).toEqual([]);
  });

  it("client users get portal links only; staff get staff links for an assigned client", () => {
    const owner = buildTour(PERSONAS.ownerA).flatMap((s) => s.links.map((l) => l.href));
    expect(owner.length).toBeGreaterThan(0);
    expect(
      owner.every((h) => h.startsWith("/portal/") || h === "/notifications" || h === "/calendar"),
    ).toBe(true);
    const staff = buildTour(PERSONAS.accountantB).flatMap((s) => s.links.map((l) => l.href));
    expect(staff.some((h) => h.startsWith("/staff/clients/"))).toBe(true);
    expect(staff.some((h) => h.startsWith("/admin"))).toBe(false);
  });
});
