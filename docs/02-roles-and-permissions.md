# 02 — User Roles and Permissions Matrix

## 1. Roles

There are two kinds of membership: **firm roles**, which are global to the Firm, and **client roles**, which are scoped to one Client. Staff access to a client also needs a **client assignment**, unless the staff member is a firm admin or manager.

| Role | Scope | Description |
|---|---|---|
| `firm_admin` | Firm | Owner or IT administrator. Manages users, roles, the client roster, platform settings and rule-set activation workflows. **Does not get bookkeeping approval rights by default.** |
| `firm_manager` | Firm, all clients | Partner or manager. Final approver for period close, tax returns, DAT files and rule-set sign-off (if also designated `tax_rule_signatory`). |
| `reviewer` | Assigned clients | Senior accountant. Reviews and approves entries and working papers prepared by others. |
| `accountant` | Assigned clients | Preparer. Records transactions, prepares returns and files, and sends requests to clients. |
| `bookkeeper` | Assigned clients | Encoder. Enters transactions and attaches documents but cannot approve anything. |
| `client_owner` | One client | Business owner or authorized officer. Manages that client's own users, approves returns for filing, and views everything for the client. |
| `client_user` | One client | Client staff. Uploads documents and answers requests. |
| `client_viewer` | One client | Read-only access to the client's reports and documents. |
| `external_auditor` | One client, time-boxed | Read-only access to the client's posted ledger and reports. Grants expire automatically. *(Phase TBD.)* |

**Capability flag (not a role):** `tax_rule_signatory`. Only a qualified accountant holding this flag can sign off a tax rule set.

## 2. Separation-of-duties rules (enforced server-side and in the database)

1. **SoD-1 (maker–checker):** the user who prepared a journal entry, return or DAT file cannot approve it.
2. **SoD-2:** a user cannot change their own roles or assignments.
3. **SoD-3:** activating a rule set requires a signatory who did not author it.
4. **SoD-4:** reopening a locked period requires `firm_manager`, a written reason, and an audit event.
5. **SoD-5:** the `firm_admin` role alone grants no access to post, approve or view client financial data. Proposed default; this is decision D-09.

## 3. Permissions matrix

Legend: ✅ allowed · 🔸 allowed only on assigned clients · 👤 own client only · ❌ denied

| Capability | firm_admin | firm_manager | reviewer | accountant | bookkeeper | client_owner | client_user | client_viewer |
|---|---|---|---|---|---|---|---|---|
| Manage firm users and roles | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Create or archive clients | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Assign staff to clients | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Manage a client's own users | ✅ | ✅ | ❌ | ❌ | ❌ | 👤 | ❌ | ❌ |
| Edit taxpayer profile and registrations | ❌ | ✅ | 🔸 | 🔸 (draft) | ❌ | 👤 (propose only) | ❌ | ❌ |
| Upload documents | ❌ | ✅ | 🔸 | 🔸 | 🔸 | 👤 | 👤 | ❌ |
| View or download documents | ❌* | ✅ | 🔸 | 🔸 | 🔸 | 👤 | 👤 | 👤 |
| Delete a document (soft delete; only if unlinked) | ❌ | ✅ | 🔸 | ❌ | ❌ | 👤 (own unprocessed uploads) | 👤 (own unprocessed uploads) | ❌ |
| Send or answer information requests | ❌ | ✅ | 🔸 | 🔸 | 🔸 | 👤 answer | 👤 answer | ❌ |
| Maintain chart of accounts | ❌ | ✅ | 🔸 | 🔸 (draft) | ❌ | ❌ | ❌ | ❌ |
| Create or edit draft entries | ❌ | ✅ | 🔸 | 🔸 | 🔸 | ❌ | ❌ | ❌ |
| Submit an entry for review | ❌ | ✅ | 🔸 | 🔸 | 🔸 | ❌ | ❌ | ❌ |
| Approve and post an entry (SoD-1) | ❌ | ✅ | 🔸 | ❌ | ❌ | ❌ | ❌ | ❌ |
| Reverse a posted entry | ❌ | ✅ | 🔸 | ❌ | ❌ | ❌ | ❌ | ❌ |
| Soft-close a period | ❌ | ✅ | 🔸 | ❌ | ❌ | ❌ | ❌ | ❌ |
| Lock a period | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Reopen a locked period (SoD-4) | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| View ledgers and reports | ❌* | ✅ | 🔸 | 🔸 | 🔸 | 👤 (approved only) | ❌ | 👤 (approved only) |
| Prepare a tax return working paper | ❌ | ✅ | 🔸 | 🔸 | ❌ | ❌ | ❌ | ❌ |
| Review and approve a return (SoD-1) | ❌ | ✅ | 🔸 | ❌ | ❌ | ❌ | ❌ | ❌ |
| Client approval of a return for filing | ❌ | ❌ | ❌ | ❌ | ❌ | 👤 | ❌ | ❌ |
| Record filing and payment proof | ❌ | ✅ | 🔸 | 🔸 | ❌ | 👤 (upload proof) | ❌ | ❌ |
| Generate a DAT file | ❌ | ✅ | 🔸 | 🔸 | ❌ | ❌ | ❌ | ❌ |
| Record official BIR validation result | ❌ | ✅ | 🔸 | 🔸 | ❌ | ❌ | ❌ | ❌ |
| Author a tax rule set | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Sign off a rule set (`tax_rule_signatory`, SoD-3) | ❌ | flag | flag | ❌ | ❌ | ❌ | ❌ | ❌ |
| View the audit log | ✅ (platform events) | ✅ | 🔸 (client events) | ❌ | ❌ | 👤 (own client's access log; to confirm) | ❌ | ❌ |
| Export client data | ❌ | ✅ | 🔸 | ❌ | ❌ | 👤 | ❌ | ❌ |

\* A `firm_admin` who also needs operational access must hold a second role, such as `firm_manager`. This makes privileged data access explicit and auditable.

## 4. Enforcement layers

1. **Database (authoritative):** RLS policies, plus `SECURITY DEFINER` functions for state transitions (post, approve, lock). Each function re-checks the caller's role and SoD from `auth.uid()`.
2. **Server (Next.js server actions and route handlers):** validate input with a schema (Zod), check authorization, then call the database function. The user-scoped Supabase client is used so that RLS still applies.
3. **UI:** hides actions the user cannot perform. This is **convenience only, never security.**

Policy tests (pgTAP) assert every cell of this matrix for at least one representative action (doc 07 §8).
