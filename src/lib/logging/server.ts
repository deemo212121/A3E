import "server-only";

import { getServerEnv } from "@/lib/env/server";

import { createLogger, type Logger } from "./logger";

let rootLogger: Logger | undefined;

/** Process-wide server logger, configured from the validated server env. */
export function getLogger(): Logger {
  if (!rootLogger) {
    const env = getServerEnv();
    rootLogger = createLogger({
      level: env.LOG_LEVEL,
      bindings: { service: "a3e-web", appEnv: env.APP_ENV },
    });
  }
  return rootLogger;
}
