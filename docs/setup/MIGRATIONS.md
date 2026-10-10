# Database Migration Workflow

All database changes (tables, RLS policies, functions, triggers, grants) are made through **versioned SQL migration files** in `supabase/migrations/`. Never change a shared or production database by hand in the dashboard.

> **Phase 2 status:** the workflow is configured, but **no migrations exist yet**. The first schema (identity, tenancy and audit) arrives in the next approved phase. The local stack has not yet been run on this machine because Docker is not installed (D-12 deferred).

## Daily workflow

```bash
npm run db:start                       # start local Supabase (Docker)
npm run db:new create_client_tables    # creates supabase/migrations/<timestamp>_create_client_tables.sql
# edit the SQL file
npm run db:reset                       # rebuild local DB from ALL migrations + seed
npm run db:lint                        # Postgres linter
npm run db:test                        # pgTAP tests in supabase/tests (from the next phase on)
npm run db:types                       # regenerate src/lib/supabase/database.types.ts
```

`db:reset` rebuilds the database from scratch every time, which proves the migrations are **repeatable** (master rule 16).

## Rules for every migration

1. **Forward-only.** Never edit a migration once it is merged. Fix problems with a new migration.
2. Every tenant table gets `ENABLE` **and** `FORCE ROW LEVEL SECURITY` in the same migration that creates it, with its policies (doc 07).
3. Constraints live in the database: `CHECK`, `UNIQUE`, foreign keys, and the immutability triggers for posted data (doc 05).
4. Every new table or policy comes with pgTAP tests in `supabase/tests/`, including cross-tenant denial tests.
5. Only synthetic seed data (`supabase/seed.sql`, when added).
6. Destructive changes (dropping or renaming columns or tables) need a written plan in the PR, covering backfill, compatibility and rollback.

## Promotion

| Step | How |
|---|---|
| Pull request | CI `database` job: `supabase start` → `db reset` → `db lint` (pgTAP is added later) |
| Staging | CI runs `supabase db push` against the staging project after merge. *To be configured when the staging project exists.* |
| Production | Same command, triggered by a manual approval step. *To be configured in the deployment phase.* |

## Recovery

Restore procedures (PITR, logical dumps, restore drills) are designed in doc 11 §3 and will be written as runbooks in `docs/runbooks/` in the deployment phase. **Back up production before applying a migration to it.**
