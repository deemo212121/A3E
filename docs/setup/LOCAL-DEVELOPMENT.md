# Local Development Setup

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 24.x (see `.nvmrc`) | Everything |
| npm | 11.x (ships with Node 24) | Dependencies |
| Git | any recent | Version control |
| **Docker Desktop** (or Podman) | recent | **Local Supabase only:** database, auth, storage and migration tests |

The Supabase CLI is installed as a project dev dependency (`supabase@2.120.0`), so there is nothing to install globally. Run it with `npx supabase …` or the `npm run db:*` scripts.

## 1. Install

```bash
npm ci
```

## 2. Configure the environment

```bash
cp .env.example .env.local
```

Choose **one** of the following:

**A. Local Supabase (recommended; requires Docker)**

```bash
npm run db:start          # first run downloads images; takes several minutes
npm run db:status         # prints the local API URL and keys
```

Copy the local **API URL** into `NEXT_PUBLIC_SUPABASE_URL` (normally `http://127.0.0.1:54321`), and the **publishable key** (or anon key) into `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Copy the secret key into `SUPABASE_SECRET_KEY` **only** if you are working on a server-side admin task.

**B. A dedicated non-production Supabase project**

Use the project's URL and publishable key from the Supabase dashboard (Project Settings → API). **Never use a production project or production data for development** (master rules 7 and 19).

## 3. Run

```bash
npm run dev               # http://localhost:3000
```

Check the configuration at `http://localhost:3000/api/health`:
- `{"status":"ok", …}` means the server and Supabase configuration are valid.
- `{"status":"degraded", "checks": {"supabaseConfig":"missing"}}` means the public Supabase variables are not set.

The health check only validates *configuration*. Database connectivity checks come in a later phase.

## 4. Before committing

```bash
npm run check
```

This runs the same steps as CI: format check, lint, typecheck, unit tests, production build, and a scan of browser bundles for secrets.

## Useful scripts

| Script | What it does |
|---|---|
| `npm run format` | Auto-format with Prettier |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run test:watch` | Tests in watch mode |
| `npm run db:stop` | Stop the local Supabase containers |
| `npm run db:types` | Regenerate TypeScript types from the local database schema |
