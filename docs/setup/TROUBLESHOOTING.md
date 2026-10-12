# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npx supabase start` → `docker: command not found (podman also not found)` | Docker is not installed or not running | Install and start Docker Desktop, then retry. On Windows, enable the WSL 2 backend. |
| `supabase start` hangs or fails on ports 54321–54324 | Ports in use, or a previous stack is still running | `npm run db:stop`, then retry. Check for other processes on those ports. |
| `/api/health` returns 503 `supabaseConfig: "missing"` | `NEXT_PUBLIC_SUPABASE_*` not set when the app was **built** or started | Set them in `.env.local`, restart `npm run dev`, or rebuild for `next start` (public variables are inlined at build time) |
| Startup error `Invalid server environment configuration: APP_ENV …` | `APP_ENV` has a value outside the allowed set | Use `development`, `test`, `staging` or `production` |
| Error `… looks like a privileged secret and must not be public` | A secret was placed in a `NEXT_PUBLIC_*` variable | Move it to `SUPABASE_SECRET_KEY` (server-only). **Rotate the key** if it was ever built or deployed. |
| Log line `Supabase env not configured; skipping session refresh` | Same as the health 503 | Configure the public Supabase variables |
| Build error mentioning `server-only` | A Client Component imports a server module | Move the logic to `src/server/**` and call it through a Server Function or Route Handler |
| ESLint `no-restricted-imports` on `@/lib/supabase/admin` | Admin client used outside `src/server/**` | Use the user-scoped server client, or move the code into `src/server/**` with an authorization check |
| `npm run check:secrets` fails | A secret value or secret variable name appears in browser bundles | Find the import chain that pulls server code into a Client Component. **Rotate the key** if a real value leaked. |
| `npm install` peer conflict for `@types/node` with Vitest | Vitest 5 requires `@types/node` 22 or ≥24 | Keep `@types/node@^24` (matches Node 24). Do not use `--force`. |
| `npm warn allow-scripts … unrs-resolver` during install | npm 11 asks before running install scripts | Harmless for current checks (lint passes). Review with `npm approve-scripts --allow-scripts-pending` if needed. |
| `cookies() … outside of a <Suspense> boundary` build error | (Only if Cache Components is re-enabled; it is off since 2026-10-12 for Cloudflare) request-time APIs must sit inside Suspense | Wrap the component that reads the session in `<Suspense>` (see `node_modules/next/dist/docs/01-app/02-guides/authentication-with-cache-components.md`) |
| `AGENTS.md` reappears after you delete it | `next dev` regenerates it | Keep it committed (Next.js 16 behaviour) |
