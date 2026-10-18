# Backup and Recovery

**Status:** procedure written 2026-10-18. Drilled only on the offline test database (see §4). **Not yet drilled on the Supabase project.**

## 1. What must be recoverable

| Data | Where | Notes |
|---|---|---|
| Books, workflow, audit trail | Supabase Postgres | Everything in `public`, `audit`, `private` |
| Uploaded documents | Supabase Storage bucket `client-documents` | Database rows hold each file's SHA-256 |
| Application code | GitHub | Cloudflare redeploys from GitHub |
| Secrets | Cloudflare dashboard, Supabase dashboard | Not in Git. Keep a copy in the firm's password manager. |

## 2. Backups

- **Database:**
  - Supabase daily backups (Pro plan and above). Point-in-time recovery is a paid add-on.
  - **Check the plan before real client data.** The free plan has no downloadable backups.
- **Extra logical backup (recommended weekly, and before every migration):**
  - Command: `pg_dump --format=custom --no-owner "$SUPABASE_DB_URL" > a3e-YYYYMMDD.dump`
  - Run it from a trusted machine. Store it encrypted, outside Supabase.
- **Storage:** Supabase backups do **not** include Storage objects. Copy the bucket periodically, e.g. with the Supabase CLI or an S3-compatible sync of the bucket.
- **Retention:** to be decided by the firm. Accounting records have statutory retention periods, so confirm them with the firm's accountant.

## 3. Restore procedure

1. **Freeze writes.** Set the Cloudflare worker to a maintenance response, or pause the project.
2. **Restore into a new project first, never over production:**
   `pg_restore --no-owner --dbname "$NEW_DB_URL" a3e-YYYYMMDD.dump`
   Or restore from a Supabase dashboard backup.
3. **Restore Storage objects** into the new project's `client-documents` bucket.
4. **Verify** before switching (this is the same check as the drill):
   - Every posted entry balances: `select id from journal_entries … having sum(debit) <> sum(credit)` returns nothing.
   - The trial balance of a few clients matches the last known report.
   - `audit.events` count and highest id match the backup time.
   - `supabase_migrations.schema_migrations` shows the expected latest version.
   - A posted entry cannot be updated, and a client user sees only their own client.
   - Documents: the stored SHA-256 matches the restored object for a sample.
5. **Switch:**
   - Point the Cloudflare variables at the restored project.
   - Redeploy.
   - Unfreeze.
6. **Record** what was lost: the time between the backup and the incident. Tell affected clients if needed.

## 4. Drill evidence

- **Offline drill:** `tests/db/resilience.test.ts`, run on every `npm run check`.
- **Steps:**
  1. Load 6,000 synthetic posted entries.
  2. Take a full physical copy.
  3. Restore it into a new instance.
- **Results confirmed:**
  - identical trial balance, entry count and audit trail
  - the same migration version
  - posted entries still immutable
  - RLS still isolating tenants
- **Not yet done:** a drill on the real Supabase project. **Do one before real client data**, and record the date and result here.
