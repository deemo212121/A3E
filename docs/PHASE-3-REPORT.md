# Phase 3 Report — Authentication, Organizations and Tenant Isolation

**Date:** 2026-10-10
**Status:** Submitted for approval. **No accounting features were built. The next phase starts only on the owner's instruction.**
**Gate:** cross-tenant security tests pass before any sensitive financial data is stored. **Met: see §4.**

## 1. Scope delivered

| Requirement | Implementation |
|---|---|
| Supabase Auth | Email and password sign-in (invitation only); password reset; mandatory TOTP MFA for firm staff, **enforced in the database** (staff permissions require an `aal2` session); `/auth/confirm` handles invite and recovery links |
| User profiles | `profiles`, created automatically from `auth.users` with a synced email; users can edit only their own `full_name` |
| Accounting-firm membership | `firm_memberships`: firm_admin, firm_manager, reviewer, accountant, bookkeeper (+ tax-rule signatory flag) |
| Client-business records | `clients` (the tenant boundary) + `client_contacts` (a sample tenant-owned record used to prove CRUD isolation; not accounting data) |
| Client memberships | `client_memberships`: client_owner, client_staff, client_viewer, with optional expiry. **The only way** a person reaches a client. |
| Invitations / approved onboarding | `invitations`, bound to an email and accepted only by the matching **confirmed** account (no bearer tokens); 72 h default expiry; revocable; Supabase invitation email for new people |
| Role assignments | `client_assignments` (preparer/reviewer) scope staff to clients; firm admins cannot be assigned (SoD-5) |
| Authorization boundaries | Database: RLS enabled and forced on all 7 public tables, plus 15 checked SECURITY DEFINER functions. Server: `requireActionAccess` / `requirePageAccess` plus role checks in every action. UI hiding is not used as security. |
| Protect invitations, membership changes, privileged actions | No direct writes; checked functions only. Nobody can change their own role or status. The last firm admin and the last client owner are protected. Client owners cannot create or remove owners. Disable and MFA reset are firm-admin only and audited. |
| Audit | `audit.events` (append-only, blocked UPDATE/DELETE/TRUNCATE), row-change triggers on all 7 tables, plus action events |
| Cross-tenant tests: reads, inserts, updates, deletes | 73 offline database tests + **31 live API tests** (§4) |
| Recovery and account-disable procedures | [runbooks/ACCOUNT-RECOVERY-AND-DISABLE.md](runbooks/ACCOUNT-RECOVERY-AND-DISABLE.md) |

**Roles supported** (as required): firm administrators, accountants, reviewers (plus managers and bookkeepers), client owners, and authorized client staff (plus read-only client viewers).

## 2. Database changes (applied to the dev project `yjbkhehsznednsutewyq` on 2026-10-10)

| Migration | Content |
|---|---|
| `20261010120000_identity_core.sql` | `private` and `audit` schemas, enums, 7 tables, triggers (updated_at, client_id immutability, assignment check, profile provisioning, audit) |
| `20261010120100_authorization_rls.sql` | 11 helper functions, minimal grants (Supabase defaults revoked), RLS enabled and forced, 11 policies |
| `20261010120200_membership_functions.sql` | 15 checked functions: access summary, clients, assignments, invitations, membership and role changes, disable, MFA reset authorization, bootstrap |

They were applied with `supabase db push`. `supabase db lint` on public, private and audit reported **no errors**.

## 3. Application changes

- **Server guards:** `src/server/auth/access.ts`. Identity and roles are loaded from the database (`get_my_access`), never from client input or JWT metadata.
- **Admin Auth helpers:** `src/server/auth/admin-auth.ts` (invite email, ban, MFA factor removal). Uses the secret key, is server-only, and runs only after the matching database authorization call.
- **Actions:** `src/features/{auth,admin,clients}/*`, all through `runAction`, which validates with Zod, returns safe errors and logs with a request id.
- **Pages:** `/login`, `/auth/forgot`, `/auth/set-password`, `/auth/confirm`, `/mfa`, `/account-disabled`, `/app` (dashboard and invitations), `/app/admin`, `/app/clients/[clientId]`.
- **Script:** `npm run bootstrap:admin -- <email>` creates the first firm admin (refuses if one exists).

## 4. Tests actually executed (2026-10-10)

| Suite | Environment | Result |
|---|---|---|
| `npm run check` (format, lint, typecheck, unit + DB tests, build, bundle secret scan) | Local | **Pass:** 9 files, **94 tests**; build OK; secret scan OK (16 files) |
| Offline DB suites (`tests/db/*`, inside `npm test`): schema guards 6, tenant isolation 46, privileged actions 21 | PGlite (Postgres 18) emulating Supabase roles, auth and default grants | **73/73 pass** |
| Mutation check: deliberately weakened RLS (SELECT `using (true)`, RLS disabled, UPDATE `using (true)`) | PGlite | The leaks **were** observed, which proves the isolation tests can fail; the probe files were deleted |
| **Live API attack suite** (`npm run test:integration`) | **Real Supabase dev project**, real users and sessions, raw HTTP to the Data API | **31/31 pass** (+1 TOTP vector test) |
| `supabase db lint` | Real dev project | No errors |
| Cleanup after the live suite | Real dev project | 0 test clients and 0 test users remain |
| App smoke test (`next start`) | Local, connected to the dev project | Unauthenticated `/app`, `/app/admin` and `/app/clients/<B>` stream a redirect to `/login` with no data rendered |

**Live demonstration, Client A against Client B** (each with a real signed-in user, raw HTTP):
- **READ:** owner, staff, viewer and the assigned reviewer of A got **only A** rows. Explicit `client_id=eq.<B>` queries on contacts, clients, memberships and invitations returned `[]`.
- **INSERT** into B: **403**, and nothing was created (verified with the service role). Self-granting membership of B: refused.
- **UPDATE** of B's record: **0 rows**, data unchanged (verified). Moving A's record into B: refused.
- **DELETE** of B's record: **0 rows**, the record still exists (verified).
- **RPC:** A's owner inviting into B, removing B's owner, changing roles in B, granting a firm role, or disabling accounts: **403**.
- **Other attacks:**
  - A forged JWT (`sub` swapped to B's owner) got **401**.
  - Anonymous requests were refused.
  - The `audit` and `private` schemas were not reachable through the API.
  - The reviewer **without MFA** saw no client data.
- **Control:** a legitimate insert by A's owner into A got **201**.

## 5. Not done, limitations and risks

| Item | Status |
|---|---|
| Hosted **dashboard settings**: sign-ups off, Site URL, redirect URLs, password policy, TOTP on, **email templates** | **Owner action** ([setup/SUPABASE-AUTH-SETUP.md](setup/SUPABASE-AUTH-SETUP.md)). The live tests did not depend on these, but invitation emails and password reset will not work correctly until the templates are set. |
| End-to-end UI walkthrough (invite email → set password → MFA → accept) | **Not executed.** It needs the email templates and a real mailbox. The flows are built and type-checked, but the email round-trip is untested. |
| First firm admin | Not created yet. `npm run bootstrap:admin -- <email>` is ready. |
| GitHub CI | Still never run (no remote, D-15). A `live-tenant-isolation` job was added; it runs only when `RUN_LIVE_TESTS=true` and the dev secrets are configured. |
| **Data region** | The dev project is in **Seoul (ap-northeast-2)**, not Singapore as doc 11 assumed. Synthetic data only, so acceptable for dev. **Production region remains part of D-04 / RA 10173 review.** |
| Audit rows from the test runs | Remain in `audit.events` (append-only by design; synthetic; they reference deleted test IDs) |
| Offline engine vs production | PGlite runs Postgres 18 and Supabase runs 17. This is mitigated by the live suite and `db lint` on the real project. |
| Supabase built-in email sender | Rate-limited; a custom SMTP provider is needed before production |
| CSP header | Still pending (planned with the deployment hardening) |
| Rate limiting on auth | Relies on Supabase Auth's built-in limits. No app-level limiter yet. |

## 6. Changes to earlier documents

- doc 02 / doc 07: `client_user` is renamed **`client_staff`** (Phase 3 wording). Documented in [security/ACCESS-CONTROL.md](security/ACCESS-CONTROL.md).
- MFA for client users is **optional** (D-11 was not decided, so it is not enforced). Staff MFA is enforced.
- D-12 was implemented using a `SUPABASE_DB_URL` connection string in `.env.local` (git-ignored) instead of `supabase link`.

## 7. Manual actions for the owner

1. Apply the **dashboard settings and email templates** ([setup/SUPABASE-AUTH-SETUP.md](setup/SUPABASE-AUTH-SETUP.md)).
2. Create the first firm admin: `npm run bootstrap:admin -- you@yourfirm.example`, then sign in, enroll MFA, and invite the rest.
3. Optional: decide D-11 (MFA for client owners).
4. When the Git remote exists: add the GitHub secrets `DEV_SUPABASE_URL`, `DEV_SUPABASE_PUBLISHABLE_KEY` and `DEV_SUPABASE_SECRET_KEY`, plus the variable `RUN_LIVE_TESTS=true`.

## 8. Acceptance criteria

- [x] Users reach a client only through an explicit membership (or a staff assignment).
- [x] Each business is its own data boundary; `client_id` is immutable.
- [x] Restrictive RLS on all tenant tables (enabled and forced, minimal grants, anon has nothing).
- [x] Permissions are enforced on the server **and** in the database.
- [x] Invitations, membership changes and privileged actions are protected and audited.
- [x] No reliance on hidden navigation or front-end filters.
- [x] Automated cross-tenant tests for reads, inserts, updates and deletes, both offline and **live through the API**, all passing.
- [x] Recovery and account-disable procedures are documented.
- [x] **Client A cannot access Client B's records via direct API requests (demonstrated live, §4).**
- [ ] Dashboard auth settings and email templates applied (owner).
- [ ] Owner approval of this report.
