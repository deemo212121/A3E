# Environments, Configuration and Secrets

## Environments

| `APP_ENV` | Where | Supabase | Data |
|---|---|---|---|
| `development` | Developer machine | Local stack (Docker) or a dedicated dev project | Synthetic only |
| `test` | CI and automated tests | Local stack started inside CI | Synthetic only |
| `staging` | Hosted preview / UAT | Separate Supabase project | Synthetic only |
| `production` | Hosted (Cloudflare planned; D-04 deferred) | Separate Supabase project with PITR | Real client data |

Rules (from docs 07 and 11):
- No environment shares a database with another.
- Production credentials never live on developer machines.
- Migrations reach staging and production **only through CI**, after review.

## Variables

| Variable | Scope | Required | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public (browser) | Yes, for any Supabase feature | Validated as a URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public (browser) | Yes, for any Supabase feature | Publishable or anon key. Protected by RLS. |
| `APP_ENV` | Server | No (default `development`) | One of `development`, `test`, `staging`, `production` |
| `LOG_LEVEL` | Server | No (default `info`) | `debug`, `info`, `warn` or `error` |
| `SUPABASE_SECRET_KEY` | **Server, privileged** | Only for admin tasks | **Bypasses RLS.** Read only by `src/lib/supabase/admin.ts`. |

All variables are validated with Zod (`src/lib/env/`). Validation errors name the variable but **never print its value**. A safety check also rejects any `NEXT_PUBLIC_*` variable that looks like a secret.

## Important: public variables are fixed at build time

Next.js **inlines `NEXT_PUBLIC_*` values into the build output**: into browser bundles, and also into server code that references them. Consequences:
- Set the correct `NEXT_PUBLIC_*` values **before** `npm run build`.
- Build **separately for each environment** (staging and production). Do not promote one build across environments.
- Changing these variables after the build has no effect until you rebuild.

Server-only variables (`APP_ENV`, `LOG_LEVEL`, `SUPABASE_SECRET_KEY`) are read at runtime.

## Where values are stored

| Environment | Store |
|---|---|
| Development | `.env.local` (git-ignored) |
| CI | GitHub Actions secrets. The current CI needs **no** secrets. |
| Staging / production | Hosting provider's secret store (e.g. Cloudflare Workers secrets once D-04 is set up) |

## Secret hygiene checks

| Check | When |
|---|---|
| `.gitignore` excludes `.env*` except `.env.example` | Always |
| `npm run check:secrets` scans `.next/static` for secret keys and secret variable names | After every build (locally and in CI) |
| gitleaks scans the full Git history | CI `secret-scan` job |
| ESLint blocks importing the admin client outside `src/server/**` | Lint |
| `import "server-only"` makes the build fail if server modules reach client code | Build |

If a secret is ever committed or exposed: **rotate it immediately** in the Supabase dashboard, then remove it from history. Rotating comes first; removing it from history does not undo exposure.
