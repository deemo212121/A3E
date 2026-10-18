import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the React Server environment; in unit
      // tests we only need it to be importable.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/db/**/*.test.ts", "tests/integration/totp.test.ts"],
    testTimeout: 30_000,
    restoreMocks: true,
    // Each DB test file runs its own in-memory Postgres (PGlite, WebAssembly)
    // with every migration; too many at once exhaust WebAssembly memory.
    maxWorkers: 6,
  },
});
