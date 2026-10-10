# Phase 2 Report — Project Setup and Development Infrastructure

**Date:** 2026-10-10
**Status:** **APPROVED by the owner on 2026-10-10.** The owner confirmed all of the following:
1. The deliverables are accepted.
2. CI verification is deferred until a Git remote exists.
3. Identity, RLS and audit move to Phase 2b.
4. The dev-only `npm audit` advisories are accepted for now.
5. Supabase project `yjbkhehsznednsutewyq` is for dev and testing only.
6. The exposed secret key has been revoked.

The next phase starts only on the owner's instruction.

## 1. Scope

As instructed: project foundation only, using the approved Phase 1 architecture. **No business tables, migrations, authentication screens, RLS policies, or accounting or tax logic were created.** Identity, memberships, RLS and the audit log (originally listed under roadmap Phase 2) move to the next phase, because the Phase 2 instruction limited this phase to the foundation. The roadmap in doc 12 has been updated to match.

## 2. Deliverables

| Required item | Where |
|---|---|
| Next.js + TypeScript (strict) | Next.js **16.4.0**, React 19.3.0, TypeScript 5, App Router, `src/` layout, Tailwind 4 |
| Application folder structure | `src/app`, `src/components/ui`, `src/features`, `src/server`, `src/lib/*`; see [setup/PROJECT-STRUCTURE.md](setup/PROJECT-STRUCTURE.md) |
| Shared UI and business-logic boundaries | ESLint `no-restricted-imports` rules plus `import "server-only"`; verified (§4) |
| Server- and browser-side Supabase clients | `src/lib/supabase/{browser,server,admin,proxy-session}.ts` (`@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.117.3) and `src/proxy.ts` (the Next 16 "Proxy", formerly Middleware) |
| Env template with placeholders only | `.env.example` |
| Environment validation | Zod schemas in `src/lib/env/`; errors name variables, never values; rejects secrets in `NEXT_PUBLIC_*` |
| Dev / test / production configuration strategy | [setup/ENVIRONMENTS.md](setup/ENVIRONMENTS.md) |
| Database migration workflow | `supabase/config.toml` (CLI 2.120.0 as a dev dependency), `supabase/migrations/`, `supabase/tests/`, `npm run db:*` scripts, [setup/MIGRATIONS.md](setup/MIGRATIONS.md) |
| Error handling foundation | `src/lib/errors/app-error.ts` (`AppError`, `toPublicError`, `ActionResult`); `app/error.tsx` and `app/global-error.tsx` show generic messages only |
| Structured logging foundation | `src/lib/logging/` dependency-free JSON logger with recursive redaction (credentials, cookies, email, phone, address, **TIN**); request ids through `x-request-id` |
| CI: lint, typecheck, tests, build | `.github/workflows/ci.yml` with three jobs: quality (format, lint, typecheck, test, build, bundle secret scan), secret-scan (gitleaks), database (local Supabase reset and lint) |
| Git hygiene | `git init` (branch `main`, **no commits, no remote**), `.gitignore` (+ `!.env.example`, Supabase temp), `.gitattributes` (LF), `.editorconfig`, `.nvmrc` (24) |
| Setup and troubleshooting docs | `README.md`, `docs/setup/*.md` (5 files) |

Additional security baseline:
- Security headers: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS.
- `poweredByHeader` is off.
- `Cache-Control: private, no-store` is set on proxied responses.
- Local Supabase auth is set to invitation only (`enable_signup = false`), TOTP MFA is enabled, and the minimum password length is 12 with mixed case and digits.

## 3. Checks actually executed (2026-10-10, Windows 10, Node 24.19.0, npm 11.17.0)

| Check | Command | Result |
|---|---|---|
| Formatting | `npm run format:check` | **Pass** |
| Lint (zero warnings allowed) | `npm run lint` | **Pass** |
| Type check (route types + `tsc --noEmit`) | `npm run typecheck` | **Pass** |
| Unit tests | `npm run test` | **Pass: 5 files, 20 tests** |
| Production build | `npm run build` | **Pass**, built with **no** env vars or secrets |
| Browser bundle secret scan | `npm run check:secrets` | **Pass** (12 files scanned) |
| **Full pipeline from a clean `.next`** | `npm run check` | **Pass (exit 0)** |

## 4. Negative and runtime verification (proves the checks work)

| Test | Result |
|---|---|
| Throwaway files importing the admin client from UI and `app/`, and server modules from feature UI | ESLint reported **all 4 violations** as errors; the files were then deleted |
| Planted a fake `sb_secret_…` value in `.next/static` | `check:secrets` **failed with exit 1** as intended; the file was removed |
| `next start`, then `GET /` | 200, all security headers present, `x-request-id` generated, `Cache-Control: private, no-store` |
| `GET /api/health` with no Supabase env | 503 `degraded`, `supabaseConfig: "missing"`; the upstream `x-request-id` was echoed back; a JSON warning was logged naming the missing variables **without values** |
| `git check-ignore` | `.env.local`, `.next`, `node_modules` and `supabase/.temp` ignored; `.env.example` not ignored |
| Grep of all to-be-committed files for secret patterns (sb_secret, JWTs) | None found |

## 5. Not executed, and why

| Item | Reason | What is needed |
|---|---|---|
| Local Supabase (`supabase start`, `db reset`, `db lint`) | **Docker or Podman is not installed.** It was attempted: `docker: command not found (podman also not found)` | D-12: install Docker Desktop |
| ~~Connecting the app to a real Supabase project~~ | **Done 2026-10-10** with a hosted Supabase dev project (`yjbkhehsznednsutewyq`). Auth API health returned 200 with the publishable key; after a rebuild `/api/health` returned **200 `ok`**; the bundle secret scan still passes. The secret key is **not** configured. | — |
| GitHub Actions CI | No Git remote (D-15 deferred). The workflow is written but **has never run** | Push to a GitHub remote, then confirm all 3 jobs pass |
| gitleaks history scan | It runs only in CI; there are no commits yet | Same as above |
| Cloudflare deployment compatibility (OpenNext) | D-04 deferred | Verify in the deployment phase |

## 6. Dependency audit

`npm audit` reports **5 high-severity** advisories, all in the **lint tool chain** (`micromatch`/`fast-glob` via `@next/eslint-plugin-next` → `eslint-config-next 16.4.0`). These are development-only packages and are not shipped to the browser or server runtime. The suggested `npm audit fix --force` would make breaking changes, so it was **not** applied. Proposed action: revisit when `eslint-config-next` publishes a fix. The audit check is not yet a CI gate.

Other notes:
- `@types/node` was aligned to `^24` to satisfy Vitest 5's peer range, matching the Node 24 runtime. No `--force` or `--legacy-peer-deps` was used.
- npm 11 asked before running `unrs-resolver`'s install script (an ESLint resolver). Lint works without it.

## 7. Changed files

**New (application):** `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `next-env.d.ts`, `eslint.config.mjs`, `vitest.config.mts`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.gitignore`, `.nvmrc`, `.env.example`, `AGENTS.md` (generated by Next.js 16), `README.md`, `.github/workflows/ci.yml`, `scripts/check-bundle-secrets.mjs`, `supabase/config.toml`, `supabase/migrations/.gitkeep`, `supabase/tests/.gitkeep`, `tests/stubs/server-only.ts`, and under `src/`: `proxy.ts`, `app/{layout,page,error,global-error}.tsx`, `app/globals.css`, `app/favicon.ico`, `app/api/health/route.ts`, `components/ui/card.tsx`, `features/README.md`, `server/README.md`, `server/system/health.ts` (+ test), `lib/env/{schema,public,server}.ts` (+ test), `lib/errors/app-error.ts` (+ test), `lib/logging/{logger,request-id,server}.ts` (+ 2 tests), `lib/supabase/{browser,server,admin,proxy-session}.ts`.

**New (docs):** `docs/setup/{LOCAL-DEVELOPMENT,ENVIRONMENTS,MIGRATIONS,PROJECT-STRUCTURE,TROUBLESHOOTING}.md`, `docs/PHASE-2-REPORT.md`.

**Updated (docs):** `docs/README.md` (index), `docs/12-risks-assumptions-questions-roadmap.md` (roadmap: Phase 2 scope split).

## 8. Unresolved risks

1. **The database layer is untested on this machine** (no Docker). Any migration work in the next phase needs D-12 first.
2. **CI has never run.** Its correctness is unproven until a remote exists (D-15).
3. **Next.js 16.4 is very recent**, and conventions changed (Proxy instead of Middleware, `retry` in error boundaries, Cache Components). The code follows the bundled Next.js docs, but future upgrades need care.
4. **Cloudflare hosting is unverified:** the Node-runtime Proxy and Cache Components must be confirmed with the OpenNext adapter (D-04).
5. **The dev-only lint chain has npm audit advisories** (§6).
6. **No CSP yet.** A nonce-based CSP needs per-request rendering and is planned with authentication.

## 9. Manual actions required

1. Install **Docker Desktop** (D-12). Then run `npm run db:start` and `npm run db:reset` and report back, or let me run them.
2. Create the **Git remote** (D-15). Then make the first commit and push, and confirm the 3 CI jobs pass. I will make the commit only when you ask.
3. Optionally, create a dedicated **non-production** Supabase project if you prefer a hosted dev database over Docker.

## 10. Acceptance criteria (gate: clean setup, checks pass, local development and Supabase connection documented)

- [x] `npm run check` passes from a clean build (format, lint, typecheck, 20 tests, build, secret scan).
- [x] No secrets are committed. `.env.example` holds placeholders only, and the bundle and file scans are clean.
- [x] No unnecessary production business tables (zero migrations).
- [x] Server and browser Supabase clients are separated; the admin client is restricted, and the restriction is verified.
- [x] Local development and the Supabase connection are documented (`docs/setup/`).
- [x] Supabase connection verified against the hosted **dev** project (configuration and Auth API reachable).
- [ ] **Migrations applied and reset**: no migrations exist yet. For the hosted dev project, this needs `supabase link`, which the owner runs because it requires the DB password. Local Docker is now optional.
- [ ] **CI executed on GitHub**: blocked by D-15 (remote).
- [x] Owner approval of this report (2026-10-10).
