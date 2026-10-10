# A3E Accounting Platform

A multi-client Philippine accounting services platform built with Next.js, TypeScript and Supabase.

> **Status:** Phase 2, project foundation. There are no accounting, tax or client features yet. Nothing in this repository claims BIR registration or compliance (see `docs/13-d02-registration-research.md`).

## Quick start

```bash
npm ci
cp .env.example .env.local      # placeholders only; fill in for your environment
npm run dev                     # http://localhost:3000
```

Without a configured Supabase project, the app still runs. `/api/health` then reports `degraded`.

## Common commands

| Command                        | Purpose                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `npm run dev`                  | Development server                                                             |
| `npm run check`                | Runs **all** checks: format, lint, typecheck, tests, build, bundle secret scan |
| `npm run test`                 | Unit tests (Vitest)                                                            |
| `npm run db:start` / `db:stop` | Local Supabase stack (requires Docker)                                         |
| `npm run db:new <name>`        | New migration file                                                             |
| `npm run db:reset`             | Rebuild the local database from all migrations                                 |

## Documentation

- Setup: [docs/setup/LOCAL-DEVELOPMENT.md](docs/setup/LOCAL-DEVELOPMENT.md)
- Environments and secrets: [docs/setup/ENVIRONMENTS.md](docs/setup/ENVIRONMENTS.md)
- Database migrations: [docs/setup/MIGRATIONS.md](docs/setup/MIGRATIONS.md)
- Project structure and boundaries: [docs/setup/PROJECT-STRUCTURE.md](docs/setup/PROJECT-STRUCTURE.md)
- Troubleshooting: [docs/setup/TROUBLESHOOTING.md](docs/setup/TROUBLESHOOTING.md)
- Requirements, architecture and BIR research: [docs/README.md](docs/README.md)

## Rules that apply to every change

- Never commit secrets. `.env*` files are git-ignored except `.env.example`, which holds placeholders only.
- Use synthetic data only in development and tests.
- `npm run check` must pass before merging.
