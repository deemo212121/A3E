# 07 — Supabase Security and Tenant-Isolation Design

## 1. Threat model (summary)

| Threat | Example | Primary control |
|---|---|---|
| Cross-tenant read or write | Client A user guesses Client B's UUID | RLS on every table; composite foreign keys |
| Privilege escalation | A bookkeeper calls the approve endpoint directly | Role checks in the database functions; SoD checks |
| Secret leakage | Service-role key in a client bundle or in Git | Server-only env vars, secret scanning in CI, `.env*` git-ignored |
| Document exfiltration | A guessable storage URL | Private bucket, storage RLS, short-lived signed URLs, access logging |
| Silent tampering with financial data | Updating a posted line | Immutability triggers; append-only audit |
| Account takeover | Phished staff password | Mandatory TOTP MFA for staff; session timeout |
| Insider misuse | Staff browsing unassigned clients | Assignment-scoped RLS; access audit |
| Injection | SQL or HTML injection | Parameterized queries only (supabase-js / RPC), Zod validation, React escaping, CSP |

## 2. Keys and secrets

| Secret | Where it lives | Where it must never appear |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or the publishable key) | Public; protected by RLS | — |
| `SUPABASE_SERVICE_ROLE_KEY` (or the secret key) | Server runtime env only, and **only** for narrowly scoped admin tasks (inviting users, scheduled jobs) | Browser code, `NEXT_PUBLIC_*`, Git, logs |
| Database password | Hosting secret store and CI secret for migrations | Git, application runtime |
| SMTP / email API key | Server env | Browser, Git |

Controls:
- Server-only modules start with `import 'server-only'`.
- CI runs secret scanning (gitleaks) on every push.
- `.env*` is git-ignored, and only `.env.example` is committed.
- **Default rule:** user requests use the *user-scoped* Supabase client (the user's JWT), so RLS always applies. The service-role client stays inside one audited module (`lib/server/admin.ts`), and its use is reviewed in code review.

## 3. Authentication

- Supabase Auth with email and password plus magic-link invitations. Self-sign-up is disabled; access is by invitation only.
- **MFA (TOTP) is mandatory for all firm roles.** RLS policies on sensitive tables check `auth.jwt()->>'aal' = 'aal2'` for staff. MFA is optional but encouraged for client users; decision D-11.
- Session lifetime and refresh policy are set in the Supabase dashboard (proposed: 8 h inactivity timeout for staff).
- Password policy: minimum length and leaked-password protection, where the plan supports it.

## 4. Authorization model in Postgres

Helper functions live in the `private` schema and are `SECURITY DEFINER`, `STABLE`, with a fixed `search_path`:

```sql
-- illustrative only (not a migration)
private.firm_role()                -> text   -- from firm_memberships where user_id = auth.uid()
private.is_firm_manager()          -> bool
private.is_assigned(client uuid)   -> bool   -- managers: true for all; staff: via client_assignments
private.client_role(client uuid)   -> text   -- from client_memberships (non-expired)
private.can_read_client(client uuid) -> bool -- is_assigned(client) OR client_role(client) IS NOT NULL
```

Policy pattern, applied to every tenant table:

```sql
alter table public.journal_entries enable row level security;
alter table public.journal_entries force row level security;

create policy je_select on public.journal_entries for select
  using ( private.is_assigned(client_id)
          or (private.client_role(client_id) in ('client_owner','client_viewer','external_auditor')
              and status in ('posted','reversed')) );

create policy je_insert on public.journal_entries for insert
  with check ( private.is_assigned(client_id) and status = 'draft' );

create policy je_update on public.journal_entries for update
  using ( private.is_assigned(client_id) and status = 'draft' )
  with check ( status = 'draft' );   -- status changes ONLY via functions
-- no delete policy => deletes denied
```

- **State transitions** (submit, approve and post, reverse, lock period, sign off a rule set) happen only through `SECURITY DEFINER` functions. Each one re-derives the caller from `auth.uid()`, checks role, assignment and SoD, and writes an audit event.
- **Role data is never trusted from `user_metadata`**, which users can edit. If custom JWT claims are used for performance, they come from an Auth hook that reads the membership tables.
- The `anon` role gets **no** grants on tenant tables.

## 5. Storage

- Bucket `client-documents`: **private**.
- Object path convention: `clients/{client_id}/{yyyy}/{mm}/{document_id}-{sanitized_name}`.
- RLS on `storage.objects`:
  - SELECT is allowed when `private.can_read_client((storage.foldername(name))[2]::uuid)` holds **and** a matching `documents` row exists that is not deleted.
  - INSERT is allowed when the user can upload to that client and the path prefix matches.
  - UPDATE and DELETE are denied. Deletion is a soft delete in `documents`, and a retention job purges later per the retention policy.
- Downloads go through a server route that checks permission, writes `audit.access_events`, and returns a **signed URL with a short TTL** (proposed: 60 s).
- Uploads are checked against a MIME allowlist and a size cap. Malware scanning is an open item (R-12).
- Generated DAT files and reports go to a separate private bucket, `client-outputs`, under the same policy model.

## 6. Audit

- Generic trigger `audit.log_change()` on all financial and permission tables writes `old` and `new` row images, the actor (`auth.uid()`) and the client.
- The application role can call `audit.log_event()` (`SECURITY DEFINER`), but it has no UPDATE or DELETE on `audit.*`, and a trigger blocks both.
- Proposed tamper evidence: each event stores `hash = sha256(prev_hash || canonical_json(event))`, and a nightly job verifies the chain.
- Sensitive reads are logged: document downloads, exports and report generation.

## 7. Web application hardening

- Next.js App Router. Mutations go through server actions or route handlers, and every input passes a Zod schema.
- Security headers: CSP (no inline scripts), `X-Frame-Options: DENY`, HSTS, `Referrer-Policy`, `Permissions-Policy`.
- Server actions are CSRF-protected by Next.js origin checks, and route handlers check `Origin`.
- Rate limiting on auth and upload endpoints.
- Dependencies: lockfile committed, automated vulnerability scanning in CI.
- Logs contain no PII or financial amounts beyond IDs. Errors are reported with scrubbing.

## 8. Verification plan (to implement in Phase 2 onward)

| Test | Tool |
|---|---|
| For each tenant table: user A cannot select, insert, update or delete client B's rows | pgTAP plus a scripted matrix of synthetic users |
| Each cell of the permissions matrix in doc 02 for a representative action | pgTAP / integration tests |
| A posted entry cannot be updated or deleted, even by a manager | pgTAP |
| An unbalanced entry cannot be posted, even via direct SQL as the app role | pgTAP |
| Storage: a cross-tenant download is denied, and a direct object URL without a signature is denied | Integration test against local Supabase |
| No service-role key in client bundles | CI grep of `.next/static` for key patterns, plus gitleaks |
| Supabase security advisors / linter report clean | `supabase db lint` and dashboard advisors |

## 9. Data privacy (RA 10173) — items for legal confirmation

- Whether the Firm acts as personal information processor or controller in each engagement, and what NPC registration it needs.
- Hosting outside the Philippines (for example in Singapore): what the cross-border transfer and accountability documentation must contain.
- Breach notification procedure and timeline.
- A retention and disposal schedule that reconciles tax record-keeping periods with privacy minimization.
- Data subject requests (access and correction) for client individuals and their employees and payees.
