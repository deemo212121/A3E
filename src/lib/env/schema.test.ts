import { describe, expect, it } from "vitest";

import {
  assertNoSecretInPublicEnv,
  EnvValidationError,
  parseEnv,
  publicEnvSchema,
  serverEnvSchema,
} from "./schema";

describe("publicEnvSchema", () => {
  it("accepts a valid URL and key", () => {
    const env = parseEnv(
      publicEnvSchema,
      {
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
      },
      "public",
    );
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });

  it("names missing variables without leaking values", () => {
    const secretLookingValue = "not-a-url-but-sensitive-123";
    let thrown: unknown;
    try {
      parseEnv(publicEnvSchema, { NEXT_PUBLIC_SUPABASE_URL: secretLookingValue }, "public");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvValidationError);
    const message = (thrown as Error).message;
    expect(message).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(message).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(message).not.toContain(secretLookingValue);
  });
});

describe("serverEnvSchema", () => {
  it("applies defaults", () => {
    const env = parseEnv(serverEnvSchema, {}, "server");
    expect(env).toEqual({
      APP_ENV: "development",
      APP_BASE_URL: "http://localhost:3000",
      LOG_LEVEL: "info",
    });
  });

  it("rejects unknown APP_ENV values", () => {
    expect(() => parseEnv(serverEnvSchema, { APP_ENV: "prod" }, "server")).toThrow(
      EnvValidationError,
    );
  });
});

describe("assertNoSecretInPublicEnv", () => {
  it("rejects secret-like public variable names", () => {
    expect(() => assertNoSecretInPublicEnv({ NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "x" })).toThrow(
      EnvValidationError,
    );
  });

  it("rejects secret keys placed in public variables", () => {
    expect(() =>
      assertNoSecretInPublicEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_abc" }),
    ).toThrow(EnvValidationError);
  });

  it("ignores non-public variables and accepts publishable keys", () => {
    expect(() =>
      assertNoSecretInPublicEnv({
        SUPABASE_SECRET_KEY: "sb_secret_abc",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc",
      }),
    ).not.toThrow();
  });
});
