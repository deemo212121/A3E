import { afterEach, describe, expect, it, vi } from "vitest";

async function loadHealth() {
  vi.resetModules(); // env loaders cache; re-import per test
  return import("./health");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getHealthReport", () => {
  it("reports ok when configuration is valid", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_placeholder");
    const { getHealthReport } = await loadHealth();
    const report = getHealthReport(new Date("2026-01-01T00:00:00Z"));
    expect(report).toEqual({
      status: "ok",
      appEnv: "test",
      checks: { serverEnv: "ok", supabaseConfig: "ok" },
      time: "2026-01-01T00:00:00.000Z",
    });
  });

  it("reports degraded without exposing values when Supabase config is missing", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const { getHealthReport } = await loadHealth();
    const report = getHealthReport();
    expect(report.status).toBe("degraded");
    expect(report.checks.supabaseConfig).toBe("missing");
  });
});
