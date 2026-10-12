import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const ADMIN_CLIENT = {
  name: "@/lib/supabase/admin",
  message: "The admin client bypasses RLS. Import it only from src/server/**.",
};

const SERVER_ONLY_MODULES = [
  { name: "@/lib/env/server", message: "Server-only env. Not allowed in UI components." },
  {
    name: "@/lib/supabase/server",
    message: "Server Supabase client. Not allowed in UI components.",
  },
  { name: "@/lib/logging/server", message: "Server logger. Not allowed in UI components." },
  ADMIN_CLIENT,
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // Boundary: the privileged admin client is only importable from src/server.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/**", "src/lib/supabase/admin.ts"],
    rules: { "no-restricted-imports": ["error", { paths: [ADMIN_CLIENT] }] },
  },
  // Boundary: shared UI and feature UI must not reach server-only code.
  {
    files: ["src/components/**/*.{ts,tsx}", "src/features/**/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: SERVER_ONLY_MODULES,
          patterns: [{ group: ["@/server/*"], message: "UI must not import server modules." }],
        },
      ],
    },
  },
  // Boundary: src/lib is the lowest layer and must not depend on src/server.
  {
    files: ["src/lib/**/*.{ts,tsx}"],
    ignores: ["src/lib/supabase/admin.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [ADMIN_CLIENT],
          patterns: [{ group: ["@/server/*"], message: "src/lib must not import src/server." }],
        },
      ],
    },
  },
  // The logger and CLI scripts write through console by design.
  {
    files: ["src/lib/logging/logger.ts", "scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
  globalIgnores([
    ".next/**",
    ".open-next/**",
    ".wrangler/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
    "supabase/.temp/**",
  ]),
]);

export default eslintConfig;
