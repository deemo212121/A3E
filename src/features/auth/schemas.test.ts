import { describe, expect, it } from "vitest";

import { safeNextPath } from "./schemas";

describe("safeNextPath (open-redirect protection)", () => {
  it("keeps same-site relative paths", () => {
    expect(safeNextPath("/portal/abc")).toBe("/portal/abc");
    expect(safeNextPath("/admin/users")).toBe("/admin/users");
  });

  it.each([
    "https://evil.example/phish",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "",
    null,
    undefined,
  ])("rejects %s", (value) => {
    expect(safeNextPath(value)).toBe("/app");
  });
});
