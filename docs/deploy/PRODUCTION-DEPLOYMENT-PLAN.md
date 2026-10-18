# Production Deployment Plan

**Status:** prepared 2026-10-18. **Not executed:** no production environment exists yet.
**Approvals needed before go-live** (§17):
- the firm owner
- the firm's accountant (compliance items)
- the person responsible for data privacy (DPO)

Provider prices and limits below are **indicative, as last known**. Confirm each on the provider's pricing page when ordering.

## 1. Environments: production is completely separate

| | Development | Staging (current) | **Production** |
|---|---|---|---|
| Supabase project | dev project (existing) | dev project | **new, separate project** in the firm's own organization |
| Cloudflare Worker | local | `a3e-accounting` (`APP_ENV=staging`) | **`a3e-production`** (`APP_ENV=production`, `wrangler.jsonc` → `env.production`) |
| Git source | any branch | `main` | **`production` branch**, updated only by a reviewed release (§5) |
| Data | synthetic | synthetic | **real client data only.** Never copy dev or staging data. |
| Accounts | demo accounts | demo accounts | **named people only.** No demo or shared accounts. |
| Secrets | `.env.local` | Cloudflare dashboard | **separate** Cloudflare secrets and Supabase keys, never reused from dev |

Rules:
- **Never** restore a dev or staging backup into production.
- **Never** run `scripts/seed-dev-accounts.mjs` against production. It refuses `APP_ENV=production`.
- The app hides all demo previews when `APP_ENV=production` (`demoEnabled()`).

## 2. Domain and HTTPS

1. **Domain:**
   - Use a domain the firm owns, e.g. `app.<firm-domain>.ph`.
   - Put the domain's DNS zone on Cloudflare (Free plan is enough).
2. **Connect it:** Workers → `a3e-production` → Settings → Domains & Routes → **Add Custom Domain**. Cloudflare issues and renews the TLS certificate.
3. **SSL/TLS settings:**
   - Mode **Full (strict)**
   - **Always Use HTTPS** on
   - Minimum TLS **1.2**
   - HSTS is already sent by the app (2 years, includeSubDomains)
4. **Supabase Auth:**
   - Site URL = `https://app.<firm-domain>.ph`
   - Redirect allow-list: exactly `https://app.<firm-domain>.ph/auth/confirm` (no wildcards, no localhost)
5. **Worker variable:** `APP_BASE_URL=https://app.<firm-domain>.ph` (used in e-mail links).
6. **Optional:** a custom SMTP sender on the firm's domain (Supabase → Auth → SMTP). The built-in sender is rate-limited and meant for testing.

## 3. Secret management

| Secret | Where it lives | Who can see it |
|---|---|---|
| `SUPABASE_SECRET_KEY` (server only) | Cloudflare → `a3e-production` → Settings → Variables → **Secret** | Firm owner, plus one technical admin |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Cloudflare build variables (public by design; protected by RLS) | — |
| Database password / `SUPABASE_DB_URL` | Firm password manager **only**. Never in Cloudflare or Git. | Owner, technical admin |
| SMTP credentials | Supabase dashboard | Owner |

Rules:
- Generate new production keys; never copy dev keys.
- Rotate on staff departure, on suspicion, and yearly.
- `npm run check` includes a bundle secret scan.
- `.env*`, `.dev.vars*` and `*.local.txt` are git-ignored.
- Turn on **2FA for the Cloudflare, Supabase and GitHub accounts** of everyone with access.

## 4. Supabase production configuration and RLS verification

1. **Create the project** in the firm's own Supabase organization.
   - Region: **Southeast Asia (Singapore)**, the nearest to the Philippines (§16 covers data transfer).
   - Plan: **Pro or higher** (backups, §6).
2. **Auth settings:**
   - **Disable "Allow new users to sign up".** People join only by invitation; the app uses the admin invite API.
   - E-mail confirmation on.
   - Minimum password length 12, with leaked-password protection on if available.
   - MFA (TOTP) enabled.
   - JWT expiry 1 hour (default).
   - Refresh token reuse detection on.
3. **Storage:**
   - The `client-documents` bucket is created by migration 0015, **private**, with a 10 MB limit.
   - Keep it private.
4. **Network:**
   - Restrict direct database connections to the firm's admin IPs (Database → Network Restrictions).
   - The app never connects directly; it uses the Data API.
5. **Apply migrations** (§5).
6. **Production-only settings**, run once in the SQL Editor after the migrations:
   ```sql
   update private.settings set value = 'false'::jsonb where key = 'allow_synthetic_purge';
   update private.settings set value = 'true'::jsonb  where key = 'require_staff_mfa';
   ```
7. **RLS verification:** run `supabase/checks/production-readiness.sql`.
   - Every row must be **PASS**.
   - **REVIEW** rows need the owner's decision.
   - **FAIL** blocks go-live.
   - It checks:
     - RLS forced on every table, plus policies
     - no anon access
     - direct writes only on the allow-list
     - search_path pinned
     - private buckets
     - no test or demo users or clients
     - MFA required
     - purge off
     - no TEST-ONLY tax definitions
     - every enabled tax output listed for review
     - all posted entries balanced
   - The same checks run automatically in `npm run check` (`tests/db/production-readiness.test.ts`, `tests/db/security-audit.test.ts`).

## 5. Database migration and release procedure

1. **Freeze:** announce a maintenance window. Releases happen outside the filing peak, never in the last 3 working days before a major deadline.
2. **Back up first:** take a logical backup (`pg_dump`, §6) and record the file name.
3. **Rehearse on staging:**
   - Apply the same SQL files to the staging project.
   - Run `npm run check`, the live suites (`npm run test:integration`, `npm run test:routes`) and the readiness SQL.
4. **Apply to production:**
   - Paste each new file, **in number order**, in the Supabase SQL Editor.
   - Each file records itself in `supabase_migrations.schema_migrations`.
   - Confirm with `select max(version) from supabase_migrations.schema_migrations;`
5. **Deploy the app:**
   - Merge `main` into `production`.
   - Cloudflare builds with `npm run cf:build` and deploys with `npx wrangler deploy --env production`.
   - Order: **SQL first, then code.** New code needs the new tables; old code tolerates new tables.
6. **Verify:**
   - Readiness SQL
   - `node scripts/smoke-production.mjs https://app.<domain> production` (must be 22/22)
   - One manual sign-in by the owner
7. **Record** the release (date, git commit, migration version, who approved) in the release log (handbook §11).

Migrations are forward-only. A bad migration is corrected by a new migration. For data damage, restore (§6, §13).

## 6. Backup schedule and restore testing

| What | How | When | Kept |
|---|---|---|---|
| Database (platform) | Supabase daily backups (Pro) | daily | 7 days (Pro); longer on higher plans |
| Database (point in time) | Supabase PITR add-on (recommended once there are real clients) | continuous | per add-on |
| Database (firm-held copy) | `pg_dump --format=custom` from the admin machine, encrypted, stored outside Supabase | weekly, and before every release | 12 months (at least) |
| Documents (Storage) | Copy the `client-documents` bucket (Supabase CLI or S3-compatible sync) | weekly | 12 months (at least) |
| Configuration | Git (code, migrations); password manager (secrets) | on change | — |

**Restore testing:**
- **Before go-live,** do one full restore drill into a scratch project: `docs/runbooks/BACKUP-AND-RECOVERY.md` §3–4.
- **Then quarterly.**
- Record the date, the backup used, the time taken and the result.
- The offline drill runs on every `npm run check`. It is **not** a substitute for this.

## 7. Monitoring, error alerts and logs

- **App logs:**
  - The app writes one JSON line per event, with a request id, and credentials and personal identifiers redacted.
  - Workers Logs are enabled (`observability`).
  - View them in Cloudflare → Workers → `a3e-production` → Logs.
- **Error alerts:**
  - Cloudflare Notifications → Workers: alert on error-rate spikes.
  - Optionally add a Logpush destination (paid) for longer retention.
- **Uptime:** an external monitor (e.g. a free uptime service) on `https://app.<domain>/api/health` every 5 minutes. It alerts the owner and the technical admin.
- **Supabase:**
  - Reports (API, Auth, database CPU, disk)
  - Usage alerts at 80% of plan quotas
  - Log Explorer for Auth and database errors
- **Weekly review** (handbook §10):
  - error logs
  - failed sign-ins
  - the activity report for unusual admin actions
  - the readiness SQL
- **Users see** a generic message with a reference number. Look the reference up as `requestId` in the logs.

## 8. Rate limits and resource limits

| Area | Setting |
|---|---|
| Sign-in, password reset, e-mail | Supabase Auth rate limits (Auth → Rate Limits). Keep the defaults or tighten them; use custom SMTP for higher e-mail volume. |
| App requests | Cloudflare **WAF rate-limiting rule** on `/login` and Server Action POSTs, e.g. 30 requests/minute per IP, blocking for 10 minutes (the Free plan includes one rule) |
| Bots | Cloudflare Bot Fight Mode on |
| Uploads | 10 MB per file (app and bucket); one file per request; type sniffing and allow-list (Phase 6) |
| Database | Statement timeouts: Supabase defaults. Reports are limited to one year (activity) and 1,000–2,000 rows per page. |
| Worker | Workers Paid ($5/month indicative) is recommended in production: more CPU time per request, and no daily request cap. The bundle is 2.9 MB of the 3 MB free limit; paid allows 10 MB. |

## 9. Storage limits and retention

- **Limits:** 10 MB per document. Duplicate files are refused per client (SHA-256).
- **Plan storage:** Supabase Pro includes 100 GB of file storage (indicative). Set a usage alert at 80%.
- **Retention:**
  - Accounting books and supporting documents must be kept for the **statutory period**.
  - Current research (doc 13, X-18): **RR 7-2024 = 5 years** from the day after the filing deadline, extended while a protest or refund is pending. The older RR 17-2013 rule was 10 years.
  - **Status V-S, PENDING VERIFICATION by the firm's accountant.**
  - Until confirmed, **keep everything for 10 years**.
- **Deletion:**
  - Documents are soft-deleted (with a reason), never hard-deleted by users.
  - Posted entries are never deleted; corrections are reversals.
  - After the confirmed retention period, offboarding exports and then removes data (handbook §12).
- **Audit trail:** `audit.events` is append-only and kept for the same period as the books.

## 10. Database and file-storage access review

| Who | Access | Review |
|---|---|---|
| Firm staff | Through the app only, by role and client assignment (RLS) | **Monthly:** Admin → Users and Review → Staff assignments; remove leavers the same day |
| Client users | Their own business only | **Quarterly,** with each client owner (Team page) |
| Supabase dashboard (SQL, Storage, keys) | Owner + one technical admin, with 2FA | **Quarterly;** remove everyone else |
| Cloudflare and GitHub | Owner + technical admin, with 2FA | **Quarterly** |
| Database password and secret key | Password manager; rotate on any change of these people | **Yearly** rotation |

Record each review (date, reviewer, changes) in the handbook log.

## 11. Admin account protection

- At most **two** firm admins: the owner and one deputy. The readiness check flags more.
- **Firm admins have no access to client books** (by design, SoD-5).
- Staff **MFA is required** in production (§4.6); enroll everyone before switching it on.
- Admins use a password manager with unique, long passwords, plus MFA on Supabase, Cloudflare, GitHub and their e-mail.
- The first admin is created once with `private.bootstrap_firm_admin('<owner e-mail>')`, run in the SQL Editor after the owner accepts the invitation. It refuses when an admin already exists.
- Role changes cannot be made on yourself; the last admin cannot be removed. Every change is audited and visible in the activity report.
- **Lost-access recovery:** `docs/runbooks/ACCOUNT-RECOVERY-AND-DISABLE.md`.

## 12. Incident response

1. **Detect:** an alert, a user report, or the weekly review.
2. **Contain:**
   - Disable the affected account (Admin → Users, or `set_user_active`).
   - Rotate exposed keys.
   - If needed, put the Worker in maintenance (deploy the previous version, or turn off the route).
3. **Assess:**
   - Use the logs (request id) and `audit.events` (activity report).
   - Answer: which clients and which data are affected.
4. **Personal data breach:**
   - The DPO decides on notification.
   - Under the Data Privacy Act (RA 10173) and NPC Circular 16-03, notify the NPC and the affected people **within 72 hours** of knowledge when the criteria are met.
   - *(Status: V-S. The DPO confirms the current NPC circulars.)*
5. **Recover:** fix, restore if needed (§6), and verify with the readiness SQL and smoke test.
6. **Review:** write up the cause and the fix within 5 working days.

Escalation contacts are in handbook §9.

## 13. Rollback

| Problem | Rollback |
|---|---|
| Bad app release | Cloudflare → Workers → `a3e-production` → **Deployments → roll back to the previous version** (or `npx wrangler rollback --env production`), then re-run the smoke test. Takes minutes; no data change. |
| Bad migration (logic) | Write a **new** corrective migration and test it on staging (no down-migrations). Meanwhile roll back the app if it misbehaves. |
| Data damage or loss | **Do not** restore over production. Restore the last good backup into a new project, verify (runbook §3.4), then switch the Worker variables to it. Record the data-loss window. |
| Compromised secret | Rotate in Supabase, update the Cloudflare secret, redeploy, then review the logs for misuse. |
| Wrong tax output enabled | A manager ends or retires it (the registry functions). Earlier results stay recorded; files generated from it are superseded by regenerating. Nothing historical is changed silently. |

**Rollback is ready when:**
- the previous deployment exists in Cloudflare
- a pre-release backup file exists
- this table has been read by whoever does the release

## 14. Initial user onboarding

1. **Owner (first firm admin):**
   - Invite the owner from the Supabase dashboard (Auth → Users → Invite).
   - The owner sets a password.
   - Run `bootstrap_firm_admin` once.
   - The owner enrolls MFA.
2. **Staff:**
   - The owner sends firm invitations (Admin → Invitations).
   - Each person accepts, sets a password and enrolls MFA.
   - The owner (or a firm manager) assigns roles and client assignments.
3. **Clients:**
   - A manager creates the client (Admin → Clients) and invites the client owner.
   - The client owner completes the business profile, which a reviewer approves.
4. **Configuration per client:**
   - chart of accounts template
   - fiscal year
   - sales and purchase settings
   - deadlines (only rules verified by the firm)
   - service status
5. **Only after real data exists:** run the production smoke tests that need a session. Use the owner's account manually; never test accounts.

## 15. Production smoke tests

| Test | Command / action | Pass |
|---|---|---|
| Anonymous checks (22; `npm run smoke -- <url> production`): health and environment name, CSP nonce and freshness, HSTS, framing, nosniff, no-store, protected pages redirect, APIs refuse anonymous, 404, HTTP→HTTPS | `node scripts/smoke-production.mjs https://app.<domain> production` | 23/23 (22, plus the HTTPS redirect on a real domain) |
| Configuration and RLS | `supabase/checks/production-readiness.sql` | All PASS; REVIEW items accepted by the owner |
| Owner sign-in with MFA | manual | dashboard loads; no errors in the logs |
| Staff sign-in with MFA, open an assigned client | manual | other clients are not visible |
| Client owner sign-in | manual | own business only |
| Upload one real document (client) and view it (staff) | manual | stored, downloadable, logged |

## 16. Data privacy and Philippine compliance review

**Status of every item: PENDING REVIEW by the firm's DPO and accountant.** These are requirements to confirm, not legal advice.

| Item | What to do | Reference (status) |
|---|---|---|
| Data Privacy Act | The firm is the personal information controller for staff and client users. Clients' own customers' and suppliers' data are processed for the client. | RA 10173 and its IRR (V-S) |
| Data Protection Officer | Designate a DPO; register with the NPC if the registration criteria apply | NPC Circular 2022-04 (V-S) |
| Privacy notice and consent | Publish a privacy notice on the sign-in page. Engagement letters cover processing for clients. | RA 10173 §§16, 18 (V-S) |
| Outsourcing and agreements | Data processing terms with Supabase and Cloudflare (their DPAs); a data-sharing/processing clause in each client engagement | RA 10173 §14 (V-S) |
| Cross-border transfer | Data hosted in Singapore (Supabase) and processed at Cloudflare's edge. The firm remains accountable. | RA 10173 §21 (V-S) |
| Security measures | Covered by Phases 3–16: RLS, MFA, encryption in transit (HTTPS) and at rest (provider), audit trail, backups | NPC security guidance (V-S) |
| Breach management | 72-hour notification process (§12) | NPC Circular 16-03 (V-S) |
| Retention | Books and records: see §9. Retention is **PENDING VERIFICATION**. | RR 7-2024 (V-S, doc 13 X-18) |
| BIR registration of the system (CAS/CBA) | **Unresolved:** doc 13 (D-02) has not concluded whether registration or an Acknowledgement Certificate is needed for this design | RMO 9-2021, RMC 5-2021 (V-P); D-02 **PENDING VERIFICATION** |
| E-invoicing | The platform issues no invoices (D-01). The register tracks requirements. | RMC 98-2026 (V-P) |
| Tax outputs | **Disabled until each passes its approval gate.** None exist at launch (§18). | Phases 12–14 |

## 17. Cost estimates and usage alerts (indicative monthly, USD)

| Item | Start (1–20 clients) | Notes |
|---|---|---|
| Supabase Pro | about $25 | includes daily backups and quotas; compute add-ons extra |
| Supabase PITR add-on | about $100 (optional at start) | recommended once there are many active clients |
| Cloudflare Workers Paid | about $5 | the Free plan is possible, but the worker is near its 3 MB limit |
| Domain | about $1–2 (yearly fee spread) | `.ph` or `.com.ph` registrar fees vary |
| Custom SMTP | $0–15 | depends on provider |
| **Total** | **about $30–50 without PITR; about $130–150 with PITR** | Confirm on the pricing pages before ordering |

**Usage alerts:**
- Supabase spend cap on, with alerts at 80% of database size, storage and egress.
- Cloudflare billing notifications.
- Monthly review of the actual bill against this table (handbook §10).

## 18. Tax outputs at go-live

- **No tax rule, BIR form, DAT layout or deadline rule ships with the platform.**
- Production starts with all registries **empty**.
- Each item is entered and approved through its gates (cited source, reviewed fixtures, second-person approval, manager sign-off) **in production**, by the firm's accountant.
- Until then, the platform:
  - records books, statements and reconciliations
  - marks tax work as *unsupported* (prepare it manually)
- The readiness SQL lists every approved or enabled item so the owner can confirm each has its evidence.

## 19. Go-live approvals and checklist

| # | Item | Approved by | Date |
|---|---|---|---|
| 1 | Phase 16 blockers B-1 to B-7 closed (`docs/PHASE-16-REPORT.md` §5) | Owner | |
| 2 | Production Supabase project created (Singapore, Pro), Auth configured (§4), sign-ups off | Owner | |
| 3 | Migrations 0001–0044 applied to production (payroll 0030–0032 if used); production settings (§4.6) | Technical admin | |
| 4 | Readiness SQL: all PASS | Technical admin | |
| 5 | Restore drill done on the real platform (§6) | Owner | |
| 6 | Domain, HTTPS, WAF rule, alerts, uptime monitor configured | Technical admin | |
| 7 | Production Worker deployed from the `production` branch; smoke test 23/23 | Technical admin | |
| 8 | Privacy review (§16) | DPO | |
| 9 | Compliance status accepted: no tax outputs enabled; D-02 open | Firm accountant | |
| 10 | **Final owner acceptance** | Owner | |
