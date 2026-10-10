import { describe, expect, it } from "vitest";

import { createLogger, redact, REDACTED } from "./logger";

function capture() {
  const lines: { level: string; entry: Record<string, unknown> }[] = [];
  const logger = createLogger({
    level: "debug",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    sink: (level, line) => lines.push({ level, entry: JSON.parse(line) }),
  });
  return { logger, lines };
}

describe("createLogger", () => {
  it("writes one JSON object per line with time, level and message", () => {
    const { logger, lines } = capture();
    logger.info("hello", { requestId: "abc" });
    expect(lines).toEqual([
      {
        level: "info",
        entry: { time: "2026-01-01T00:00:00.000Z", level: "info", msg: "hello", requestId: "abc" },
      },
    ]);
  });

  it("filters below the configured level", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: (_l, line) => lines.push(line) });
    logger.info("skip");
    logger.warn("keep");
    expect(lines).toHaveLength(1);
  });

  it("redacts credentials and personal identifiers, including nested and in bindings", () => {
    const { logger, lines } = capture();
    logger.child({ apiKey: "k1" }).error("boom", {
      user: { email: "a@example.com", password: "p", id: "u1" },
      headers: { authorization: "Bearer t", cookie: "sb=1" },
      taxpayer: { tin: "123456789", registeredName: "Synthetic Co." },
      SUPABASE_SECRET_KEY: "sb_secret_x",
    });
    const entry = lines[0].entry;
    const text = JSON.stringify(entry);
    for (const leaked of ["k1", "a@example.com", "Bearer t", "sb=1", "123456789", "sb_secret_x"]) {
      expect(text).not.toContain(leaked);
    }
    expect(entry.apiKey).toBe(REDACTED);
    expect((entry.user as Record<string, unknown>).id).toBe("u1");
  });

  it("serializes Error objects with name and message", () => {
    const { logger, lines } = capture();
    logger.error("failed", { error: new Error("db down") });
    const err = lines[0].entry.error as Record<string, unknown>;
    expect(err.name).toBe("Error");
    expect(err.message).toBe("db down");
  });
});

describe("redact", () => {
  it("truncates very deep structures", () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain("[Truncated]");
  });
});
