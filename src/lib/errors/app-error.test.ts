import { describe, expect, it } from "vitest";

import { AppError, fail, ok, toPublicError } from "./app-error";

describe("AppError", () => {
  it("maps codes to HTTP statuses", () => {
    expect(new AppError("FORBIDDEN", "x").status).toBe(403);
    expect(new AppError("CONFLICT", "x").status).toBe(409);
  });
});

describe("toPublicError", () => {
  it("exposes only the public message and field errors of an AppError", () => {
    const error = new AppError("VALIDATION", "internal: column tin violates check", {
      fieldErrors: { tin: ["TIN must be 9 digits"] },
      context: { sql: "insert into ..." },
    });
    const pub = toPublicError(error, "req-12345678");
    expect(pub).toEqual({
      code: "VALIDATION",
      message: "Some of the information provided is invalid.",
      fieldErrors: { tin: ["TIN must be 9 digits"] },
      requestId: "req-12345678",
    });
    expect(JSON.stringify(pub)).not.toContain("column tin");
    expect(JSON.stringify(pub)).not.toContain("insert into");
  });

  it("converts unknown errors to a generic INTERNAL error", () => {
    const pub = toPublicError(new Error('relation "secret_table" does not exist'));
    expect(pub.code).toBe("INTERNAL");
    expect(pub.message).not.toContain("secret_table");
  });
});

describe("ActionResult helpers", () => {
  it("wraps success and failure", () => {
    expect(ok(1)).toEqual({ ok: true, data: 1 });
    const failed = fail(new AppError("NOT_FOUND", "row missing"));
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("NOT_FOUND");
  });
});
