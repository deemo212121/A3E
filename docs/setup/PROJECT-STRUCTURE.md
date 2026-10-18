# Project Structure and Boundaries

```
.
├── .github/workflows/ci.yml   CI: quality checks, secret scan, database job
├── docs/                      Requirements, architecture, research, setup
├── scripts/                   Node CLI scripts (e.g. check-bundle-secrets.mjs)
├── supabase/
│   ├── config.toml            Local stack config (sign-up disabled, TOTP MFA on)
│   ├── migrations/            Versioned SQL (none yet)
│   └── tests/                 pgTAP database tests (none yet)
├── tests/stubs/               Test-only stubs (server-only)
└── src/
    ├── app/                   Next.js routes: pages, layouts, error boundaries, route handlers
    │   └── api/health/        Configuration health endpoint
    ├── components/ui/         Shared presentational UI (no data access)
    ├── features/              Per-module UI, server actions and schemas (none yet)
    ├── server/                SERVER-ONLY business logic (authorization, workflows)
    ├── lib/
    │   ├── env/               Zod-validated environment (public / server / admin)
    │   ├── errors/            AppError, public error mapping, ActionResult
    │   ├── logging/           Structured JSON logger with redaction; request ids
    │   └── supabase/          browser, server (user/RLS), admin (privileged), proxy session
    └── proxy.ts               Next.js 16 Proxy: session refresh, request id, no-store
```

## Layer rules

```
app/ ──► features/ ──► server/ ──► lib/
  │          │                      ▲
  └──────────┴──► components/ui ────┘ (UI may use pure lib modules only)
```

| Rule | Enforced by |
|---|---|
| `@/lib/supabase/admin` (bypasses RLS) is importable **only** from `src/server/**` | ESLint `no-restricted-imports` |
| `src/components/**` and `src/features/**/components/**` cannot import `@/server/*`, server env, the server Supabase client or the server logger | ESLint |
| `src/lib/**` cannot import `@/server/*` | ESLint |
| Server modules start with `import "server-only"`, so a build fails if one reaches the browser | Next.js build |
| Public env values are referenced literally (`process.env.NEXT_PUBLIC_X`) so Next.js can inline them | Code review (`src/lib/env/public.ts`) |

These rules were verified by deliberately violating them in throwaway files: ESLint reported all 4 violations (Phase 2 report).

## Supabase clients: which to use

| Client | File | Acts as | Use in |
|---|---|---|---|
| Browser | none by design | — | Session cookies are HttpOnly (`src/lib/supabase/cookies.ts`); pages get data from the server only |
| Server | `src/lib/supabase/server.ts` | Signed-in user (RLS) | Server Components, Server Functions, Route Handlers |
| Proxy session | `src/lib/supabase/proxy-session.ts` | Refreshes session cookies | `src/proxy.ts` only |
| **Admin** | `src/lib/supabase/admin.ts` | **Service (bypasses RLS)** | `src/server/**` only, after authorization checks |

## Errors and logging

- Throw `AppError(code, internalMessage, { publicMessage, fieldErrors, context })` in server code.
- At the boundary (Route Handler or Server Function), return `toPublicError(error, requestId)` or `fail(error)`. Internal messages, SQL errors and stacks never reach the browser.
- Log with `getLogger()` (server) or `createLogger()` (pure). Keys such as password, token, secret, cookie, authorization, email, phone, address and **TIN** are redacted automatically.
- Each request carries an `x-request-id`, which is set or validated in the proxy and returned in responses.
