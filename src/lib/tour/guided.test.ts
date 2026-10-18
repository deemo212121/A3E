import { describe, expect, it } from "vitest";

import { A, PERSONAS } from "@/lib/access/personas.fixture";
import { evaluateRoute, matchRoute } from "@/lib/access/route-policy";

import { buildGuidedTour } from "./guided";

describe("guided tour over the sample client", () => {
  for (const [persona, facts] of Object.entries(PERSONAS)) {
    it(`${persona}: every step page is one they may open`, () => {
      for (const step of buildGuidedTour(facts, A)) {
        if (!step.path) continue;
        const m = matchRoute(step.path);
        expect(m, step.path).not.toBeNull();
        expect(evaluateRoute(m!.route, facts, m!.params).allowed, `${persona} ${step.path}`).toBe(
          true,
        );
      }
    });
  }

  it("staff walk the staff pages, the client owner walks the portal", () => {
    const paths = (p: keyof typeof PERSONAS) =>
      buildGuidedTour(PERSONAS[p], A).map((s) => s.path ?? "");
    expect(
      paths("reviewerA").filter((p) => p.startsWith(`/staff/clients/${A}`)).length,
    ).toBeGreaterThan(5);
    expect(paths("ownerA").some((p) => p.startsWith("/staff"))).toBe(false);
    expect(paths("ownerA").filter((p) => p.startsWith(`/portal/${A}`)).length).toBeGreaterThan(3);
    // every step has something to say, even without a page
    for (const s of buildGuidedTour(PERSONAS.outsider, A))
      expect(s.title.length).toBeGreaterThan(0);
  });
});
