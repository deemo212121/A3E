# Phase 17 Report: Production Deployment

**Date:** 2026-10-18
**Gate:** *Live ang system, secured ang configuration, tested ang backups, at documented ang rollback.* (The system is live, the configuration is secured, backups are tested, and rollback is documented.)

**Result:**
- **Not deployed.** There is **no production URL**.
- The plan, configuration and tooling are ready. Deployment needs approvals and owner-only actions, listed in §4.
- The gate is **not yet met**: the system is not live, and the backup restore has not been tested on the real platform.

| Gate item | Status |
|---|---|
| System live | **No.** Waiting for approvals and owner actions (§4) |
| Configuration secured | **Prepared.** Plan §3, §4, §10, §11. Verified automatically by the readiness SQL, and in tests. |
| Backups tested | **Offline drill only** (`tests/db/resilience.test.ts`). The real-platform drill is in plan §6 and is **not done**. |
| Rollback documented | **Yes.** Plan §13 |

## 1. Delivered

| Item | File |
|---|---|
| Production deployment plan, covering all 16 required topics plus tax outputs and approvals | `docs/deploy/PRODUCTION-DEPLOYMENT-PLAN.md` |
| Separate production Worker configuration (`a3e-production`, `APP_ENV=production`); staging unchanged | `wrangler.jsonc` → `env.production` |
| Read-only production readiness check: RLS, grants, MFA, purge off, no test data, no TEST-ONLY tax definitions, every enabled tax output listed for review, books balanced | `supabase/checks/production-readiness.sql` |
| Test that the readiness check runs and catches what it should | `tests/db/production-readiness.test.ts` |
| Anonymous production smoke test (no accounts, no data written) | `scripts/smoke-production.mjs` |
| Backup and restore runbook | `docs/runbooks/BACKUP-AND-RECOVERY.md` (Phase 16) |

## 2. Tests executed (2026-10-18)

| Test | Where | Result |
|---|---|---|
| `npm run check`: format, lint, typecheck, all unit and database tests, production build, bundle secret scan | local | see the final totals in the handover report |
| Readiness SQL on a migrated database: passes once purge is off; fails on test users, test clients and MFA off | PGlite (`production-readiness.test.ts`) | Pass (2/2) |
| Smoke test against the **local production build** (`next start`) | local | **22/22 pass.** The HTTPS-redirect check only runs on a real `https://` URL. |
| `wrangler deploy --dry-run --env production` | local | Valid: Worker `a3e-production`, `APP_ENV=production`, 2,920 KiB gzip |
| `wrangler deploy --dry-run` (staging) | local | Valid, unchanged |
| Production smoke test, readiness SQL on production, restore drill on production | — | **Not run.** No production environment yet. |

## 3. Rollback

Plan §13:
- app: roll back to the previous Worker deployment
- migration: forward fix
- data: restore into a new project
- secret: rotate
- tax output: end or retire

## 4. Needed before deployment (owner and approvers)

1. Close the Phase 16 blockers B-1 to B-7 (`docs/PHASE-16-REPORT.md` §5). In particular:
   - apply SQL 0036–0044
   - re-enable MFA
   - run the live suites
   - do a real restore drill
2. Create the production Supabase project (plan §4) and the `a3e-production` Worker connected to a `production` branch:
   - build: `npm run cf:build`
   - deploy: `npx wrangler deploy --env production`
3. Domain, secrets, alerts and WAF (plan §2, §3, §7, §8).
4. Approvals and final owner acceptance (plan §19).

**No development secret or test data is copied into production by anything in this phase.**
