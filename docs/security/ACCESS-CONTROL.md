# Access Control and Tenant Isolation (as implemented in Phase 3)

This implements the design in [doc 07](../07-security-and-tenant-isolation.md) and [doc 02](../02-roles-and-permissions.md). Where the implementation differs from the design, it is noted.

## 1. Data ownership boundary

- Each **client business** (`public.clients`) is a tenant. Every tenant-owned row carries `client_id`, which **cannot be changed** after creation (trigger `forbid_client_id_change`).
- A person reaches a client's data **only** through:
  - an explicit **client membership** (`client_memberships`: owner, staff or viewer), or
  - a firm **assignment** (`client_assignments`: preparer or reviewer) for reviewers, accountants and bookkeepers. **Firm managers** see all clients.
- **Firm admins** administer users and the client roster, but have **no implicit access to client business records** (SoD-5).

## 2. Roles

| Role | Scope | Notes |
|---|---|---|
| `firm_admin` | Firm | Users, firm roles, account disable/enable, MFA reset, client roster, invitations |
| `firm_manager` | All clients | Creates clients, assigns staff, manages client members |
| `reviewer`, `accountant`, `bookkeeper` | Assigned clients | Read and write client records; delete only as manager or reviewer |
| `client_owner` | Own client | Manages own client's staff and viewers. Cannot create or remove owners; only the firm can. |
| `client_staff` | Own client | Reads and writes records; cannot delete |
| `client_viewer` | Own client | Read-only |

*Naming change from doc 02:* `client_user` is now **`client_staff`**, matching the Phase 3 wording ("authorized client staff").

## 3. Enforcement layers

| Layer | Mechanism | Where |
|---|---|---|
| Database (authoritative) | RLS **enabled and forced** on every public table; SECURITY DEFINER helpers in the non-exposed `private` schema; table grants reduced to the minimum (Supabase's broad defaults are revoked) | `supabase/migrations/20261010120100_*.sql` |
| Database functions | All membership, role, invitation and account changes go through checked functions that re-derive the caller from `auth.uid()`, check authority and SoD, and audit | `20261010120200_*.sql` |
| Server | Every server action calls `requireActionAccess()` plus a role check **before** calling the database. Pages call `requirePageAccess()` | `src/server/auth/access.ts`, `src/features/*/actions.ts` |
| Routes (Phase 4) | `guardRoute()` in every protected page evaluates the shared route policy; proxy 307 without a session; navigation generated from the same policy | `src/lib/access/route-policy.ts`, `src/server/auth/route-guard.ts` |
| UI | Hides controls the user cannot use. **This is not a security control.** | `src/app/**` |

## 4. Rules enforced in the database

- Staff permissions require an **MFA (aal2) session**. Without it, `private.firm_role()` returns null and staff see no client data.
- A **disabled** account (`profiles.is_active = false`) loses all data access at once, even with a still-valid JWT.
- **Expired** memberships and **archived** clients grant client users nothing.
- No direct writes to `clients`, `client_memberships`, `client_assignments`, `firm_memberships` or `invitations`, and no reads of `audit.*`.
- `client_contacts` (the sample tenant table): insert and update only for the caller's own client(s), limited to granted columns; `created_by` is forced to the caller; delete only by the owner or by a manager/reviewer.
- Separation of duties:
  - Nobody can change their own firm role, client role or account status.
  - Client owners cannot grant or remove the owner role.
  - The last active firm admin and the last active client owner are protected.
- Invitations are bound to an email and accepted only by the user whose **confirmed** email matches. Another person's invitation cannot be probed: "not yours" returns the same "not found" as a missing invitation.
- `audit.events` is append-only: UPDATE, DELETE and TRUNCATE are blocked by trigger.

## 5. How this is verified

| Suite | What it proves | Command |
|---|---|---|
| `tests/db/schema-guards.test.ts` | Every table has RLS enabled and forced; anon has no table privileges or function execute; SECURITY DEFINER functions pin `search_path` | `npm test` |
| `tests/db/tenant-isolation.test.ts` | Reads, inserts, updates and deletes across tenants are refused for every role, using hand-written SQL as the API role | `npm test` |
| `tests/db/privileged-actions.test.ts` | Invitations, role changes, disable and MFA reset can only be done by the right roles; audit is append-only | `npm test` |
| `tests/integration/cross-tenant.api.test.ts` | The same attacks as **direct HTTP requests** to the live Supabase Data API with real user sessions, forged JWTs, anonymous requests and schema-switching headers | `npm run test:integration` |

The offline suites run Postgres 18 (PGlite) with an emulation of Supabase's roles, `auth` schema and default grants. Supabase itself runs Postgres 17. The live suite covers the real platform.
