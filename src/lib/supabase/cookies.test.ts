import { describe, expect, it } from "vitest";

import { hardenSessionCookie } from "./cookies";

describe("hardenSessionCookie", () => {
  it("forces HttpOnly and SameSite=Lax, and Secure in production", () => {
    expect(
      hardenSessionCookie({ path: "/", httpOnly: false, sameSite: "none", maxAge: 10 }, true),
    ).toEqual({
      path: "/",
      maxAge: 10,
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
  });
  it("allows plain HTTP only outside production (local development)", () => {
    expect(hardenSessionCookie(undefined, false)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
    });
  });
});
