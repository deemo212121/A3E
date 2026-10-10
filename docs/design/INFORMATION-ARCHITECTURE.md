# Information Architecture and Route Access (Phase 4)

> **Status: PROPOSED** (derived from Phase 1 docs 02 and 03). The single source of truth in code is `src/lib/access/route-policy.ts`.

## 1. Workspaces (distinct experiences)

| Workspace | Who | Purpose | Routes |
|---|---|---|---|
| **Client portal** | client_owner, client_staff, client_viewer (only their own businesses) | Business overview, contacts, team, and later documents and requests | `/portal`, `/portal/[clientId]`, `…/contacts`, `…/team`, `…/documents`, `…/requests` |
| **Accounting staff portal** | firm_manager, reviewer, accountant, bookkeeper (assigned clients only; managers see all) | Daily work on assigned clients | `/staff`, `/staff/clients/[clientId]` |
| **Reviewer / manager workspace** | firm_manager, reviewer | Review queue; staff assignments (managers) | `/review`, `/review/assignments` |
| **Firm administration** | firm_admin, firm_manager (users: admin only) | Client roster, client admin, users, invitations | `/admin`, `/admin/clients`, `/admin/clients/[clientId]`, `/admin/users`, `/admin/invitations` |
| Account (everyone) | any active user | Profile, session, invitations | `/account`, `/invitations` |
| Home router | any active user | Sends the user to their primary workspace | `/app` |

Public routes: `/`, `/login`, `/auth/*`, `/mfa`, `/account-disabled`, `/api/health`.

## 2. Route access matrix (✓ = allowed; client-scoped rows assume the persona's own client)

| Route | firm_admin | firm_manager | reviewer | accountant / bookkeeper | client_owner | client_staff | client_viewer | no role |
|---|---|---|---|---|---|---|---|---|
| `/account`, `/invitations`, `/app` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/portal` | – | – | – | – | ✓ | ✓ | ✓ | – |
| `/portal/[own client]/*` | not-found | not-found | not-found | not-found | ✓ | ✓ | ✓ | not-found |
| `/portal/[other client]/*` | not-found | not-found | not-found | not-found | not-found | not-found | not-found | not-found |
| `/staff` | – | ✓ | ✓ | ✓ | – | – | – | – |
| `/staff/clients/[assigned]` | – | ✓ (all) | ✓ | ✓ | – | – | – | – |
| `/staff/clients/[assigned]/journal`, `…/journal/[entry]`, `…/trial-balance`, `…/ledger`, `…/accounts`, `…/periods` (Phase 5) | – | ✓ (all) | ✓ | ✓ (actions limited by role in the database) | – | – | – | – |
| `/staff/clients/[unassigned]` | – | ✓ (all) | not-found | not-found | – | – | – | – |
| `/review` | – | ✓ | ✓ | – | – | – | – | – |
| `/review/assignments` | – | ✓ | – | – | – | – | – | – |
| `/admin`, `/admin/clients`, `/admin/clients/[id]`, `/admin/invitations` | ✓ | ✓ | – | – | – | – | – | – |
| `/admin/users` | ✓ | – | – | – | – | – | – | – |

"–" renders **Access denied**; "not-found" renders **Page not found**, so another tenant's existence is never revealed. Firm admins have **no route into client business records** (SoD-5).

Session states take priority over the matrix:
- **no session:** 307 redirect to `/login?next=…`
- **disabled:** redirect to `/account-disabled`
- **staff without MFA:** redirect to `/mfa`

## 3. Enforcement (navigation visibility is never authorization)

| Layer | Behaviour |
|---|---|
| Proxy (`src/proxy.ts`) | Optimistic only: no session on a protected prefix gets a **307** to `/login?next=<path>` |
| Page guard (`guardRoute`) | Runs in **every** protected page, on every request (direct URL, reload, new tab, client navigation). Loads facts from the database and evaluates the shared policy. |
| Data | Every query goes through the user-scoped client under **RLS**. The client row is reloaded under RLS even after the guard allows. |
| Navigation | `buildNavigation(facts)` / `clientPortalTabs(facts)` are generated **from the same policy**, so they cannot list a route the guard would refuse |
| Layout | `(workspace)/layout.tsx` renders the shell only. It is **not** a security boundary. |
| Post-login redirect | `next` accepts same-site paths only (`safeNextPath`; open redirects are tested) |

## 4. Demo data

Screens whose features arrive later (documents, requests, work queue, review queue) show **synthetic rows** from `src/server/demo/demo-data.ts`:
- always inside a dashed **"DEMO DATA"** notice,
- never stored in the database,
- hidden when `APP_ENV=production`.
