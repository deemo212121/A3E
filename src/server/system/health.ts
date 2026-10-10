import "server-only";

import { getPublicEnv } from "@/lib/env/public";
import { getServerEnv } from "@/lib/env/server";

export interface HealthReport {
  status: "ok" | "degraded";
  appEnv: string;
  checks: {
    serverEnv: "ok" | "invalid";
    supabaseConfig: "ok" | "missing";
  };
  time: string;
}

/**
 * Liveness/configuration report. Exposes only pass/fail flags, never values
 * or variable contents. Database connectivity checks are added in a later
 * phase once a database environment is available.
 */
export function getHealthReport(now: Date = new Date()): HealthReport {
  let appEnv = "unknown";
  let serverEnv: HealthReport["checks"]["serverEnv"] = "ok";
  try {
    appEnv = getServerEnv().APP_ENV;
  } catch {
    serverEnv = "invalid";
  }

  let supabaseConfig: HealthReport["checks"]["supabaseConfig"] = "ok";
  try {
    getPublicEnv();
  } catch {
    supabaseConfig = "missing";
  }

  return {
    status: serverEnv === "ok" && supabaseConfig === "ok" ? "ok" : "degraded",
    appEnv,
    checks: { serverEnv, supabaseConfig },
    time: now.toISOString(),
  };
}
