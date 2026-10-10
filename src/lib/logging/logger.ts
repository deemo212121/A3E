/**
 * Structured JSON logger.
 *
 * Dependency-free so it runs in Node.js and in edge/Workers runtimes. Each log
 * line is one JSON object written through `console`, which hosting platforms
 * collect. Sensitive keys are redacted recursively before output.
 */

import type { LogLevel } from "@/lib/env/schema";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Keys whose values are never logged. Matching is case-insensitive on the key
 * name. Includes credentials and personal/tax identifiers (e.g. TIN).
 */
const REDACT_KEY_PATTERN =
  /pass(word)?|secret|token|api[-_]?key|apikey|authorization|cookie|session|service[-_]?role|^tin$|tin[-_]?no|taxpayer[-_]?id|^email$|phone|address/i;

export const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: LogContext;
  /** Output sink; defaults to console. Injectable for tests. */
  sink?: (level: LogLevel, line: string) => void;
  now?: () => Date;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[Truncated]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
      ...("code" in value ? { code: (value as { code: unknown }).code } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = REDACT_KEY_PATTERN.test(key) ? REDACTED : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = options.level ?? "info";
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());

  const write = (level: LogLevel, message: string, context?: LogContext) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const entry = {
      time: now().toISOString(),
      level,
      msg: message,
      ...(redact({ ...bindings, ...context }) as LogContext),
    };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ time: entry.time, level, msg: message, logError: "unserializable" });
    }
    sink(level, line);
  };

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
    child: (childBindings) =>
      createLogger({ ...options, bindings: { ...bindings, ...childBindings } }),
  };
}
