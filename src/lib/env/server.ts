import "server-only";

import { adminEnvSchema, parseEnv, serverEnvSchema, type AdminEnv, type ServerEnv } from "./schema";

let cachedServer: ServerEnv | undefined;

/** Server-only environment. Importing this from client code fails the build. */
export function getServerEnv(): ServerEnv {
  cachedServer ??= parseEnv(
    serverEnvSchema,
    {
      APP_ENV: process.env.APP_ENV,
      APP_BASE_URL: process.env.APP_BASE_URL,
      LOG_LEVEL: process.env.LOG_LEVEL,
    },
    "server",
  );
  return cachedServer;
}

/** Privileged key for the admin client. Not cached, to keep its lifetime short. */
export function getAdminEnv(): AdminEnv {
  return parseEnv(
    adminEnvSchema,
    { SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY },
    "admin",
  );
}
