import { describe, expect, it } from "vitest";

import { resolveRequestId } from "./request-id";

describe("resolveRequestId", () => {
  it("reuses a well-formed upstream id", () => {
    expect(resolveRequestId("abc-12345678")).toBe("abc-12345678");
  });

  it("replaces missing or malformed ids with a UUID", () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(resolveRequestId(null)).toMatch(uuid);
    expect(resolveRequestId("short")).toMatch(uuid);
    expect(resolveRequestId("bad id\n<script>")).toMatch(uuid);
  });
});
