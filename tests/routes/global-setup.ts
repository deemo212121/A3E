import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Starts the PRODUCTION build (`next start`) for the route-access tests.
 * Requires `npm run build` first (the test:routes script does this).
 */
export const PORT = 3199;
let server: ChildProcess | undefined;

export async function setup() {
  if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
    throw new Error("No production build found. Run `npm run build` first.");
  }
  server = spawn(
    process.execPath,
    [join("node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)],
    { cwd: process.cwd(), stdio: "ignore", env: { ...process.env, NODE_ENV: "production" } },
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.status === 200 || res.status === 503) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("next start did not become ready in 60s");
}

export async function teardown() {
  server?.kill();
}
