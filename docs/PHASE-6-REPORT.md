# Phase 6 Report — Client Portal and Standardized Data Intake

**Date:** 2026-10-10
**Status:** Submitted for review. **Nothing is posted automatically and no tax is computed.** The next phase starts only on the owner's instruction. Sending the Phase 6 instruction was taken as approval of Phase 5.
**Gate:** *Isang valid submission lang ang naitatala, at hindi ito nade-duplicate kapag nag-retry* (one valid submission is recorded once, and is never duplicated by retries). **Met.** It is proven on the real Supabase project with simultaneous retries (§3).

## 1. What was built

| Area | Delivered |
|---|---|
| **Canonical schema** | One generic transaction (8 kinds, header + lines + an `attributes` extension point), customers/suppliers, versioned business profile, documents, status history, comments. See [intake/CANONICAL-INTAKE-SCHEMA.md](intake/CANONICAL-INTAKE-SCHEMA.md). |
| **Statuses** | `draft`, `submitted`, `needs_correction`, `reviewed`, `approved`, `rejected`, `posted` (+ `cancelled`), with one transition table for every record type |
| **Validation** | Required fields by kind, enforced in the browser form, in the server action (Zod) and in the database (final authority) |
| **Feedback and resubmission** | Staff return a record with a required comment. The client sees it, corrects and resubmits; a resubmission needs a fresh review. Internal staff notes are hidden from clients. |
| **Tracking and audit** | Every status change goes to `intake_events` (append-only) and `audit.events`. Downloads are logged. Row-level audit runs on all new tables except import staging rows (audited per batch). |
| **Private documents** | Byte-level type checks, size limits, no direct uploads, 60-second signed downloads, soft delete with a reason, duplicate-file detection |
| **CSV/XLSX import** | Column mapping with suggestions, header-row detection, preview with row-level errors (Excel row numbers), duplicate and possible-duplicate detection, summary, retry-safe commit. Imports create *submitted* records only. |
| **Ledger link** | An **approved** transaction is booked through a journal entry (normal maker-checker). It becomes `posted` only when that entry posts, and returns to `approved` if the entry is reversed. It can be booked once. |
| **Client portal** | New tabs: Transactions, Documents, Imports, Customers & suppliers, Business profile. The overview shows status counts and a "needs your correction" alert. Viewers can read but not change. |
| **Staff workspace** | Intake tab (queues with counts, review/approve/reject, record on the client's behalf), Imports tab, and intake items in the Review queue |

**New database objects:**
- 10 tables, all with RLS enabled and forced, and read-only for API users. Writes go only through 17 checked functions.
- The private storage bucket and its read policy.
- The download route.

**Migrations:**
- `20261010160000` intake_core
- `160100` intake_functions
- `160200` intake_imports
- `160300` intake_ledger_link
- `160400` intake_read_models
- `160500` intake_lint_fixes

All are applied to the dev project, and `supabase db lint` reports **no errors**.

## 2. Tests actually executed (2026-10-10)

| Suite | Environment | Result |
|---|---|---|
| `npm run check` (format, lint, typecheck, unit + DB tests, build, secret scan) | Local | **Pass:** 20 files, **311 tests** |
| Intake workflow (`tests/db/intake.test.ts`) | PGlite (Postgres 18) | **32/32**: permissions per role, retry replay, duplicate receipts, required fields, future date, line totals, bad values, the full review/correction/approval cycle, maker-checker, frozen content (also for the table owner), history order and append-only, comments and internal notes, profile versions, customer/supplier duplicates, isolation, no direct writes, booking only when approved, posting and reversal |
| Documents (`tests/db/documents.test.ts`) | PGlite + Storage stub | **16/16**: who may upload, path fixed by the database, refused types/sizes/hashes, retry replay, same file twice, racing completions, **no direct storage writes**, reads by tenant only, pending uploads hidden, review, soft-delete rules, access logging |
| Imports (`tests/db/imports.test.ts`) | PGlite | **14/14**: source-file checks, 5,000-row limit, retry, row classification (ready/error/duplicate/in-file duplicate/possible duplicate), commit once + retries, re-import finds duplicates, explicit opt-in, database re-validation, isolation, supplier-list import |
| File safety and parsing (`src/lib/intake/*.test.ts`) | Unit | **30/30**: executables renamed `.pdf`, HTML/SVG disguised as PDF/PNG/CSV, type mismatches, macro and embedded-object Office files, a 20 MB **zip bomb** in a < 200 KB file, damaged archives, empty/oversize, path traversal and right-to-left-override file names; CSV quoting/encodings/limits; XLSX read of a file written by an **independent library** (title rows, dates, float noise, entities, formulas as cached values, DTD refusal); dates/amounts/TINs |
| **Live intake suite** (`tests/integration/intake.live.test.ts`) | **Real Supabase + Storage** | **12/12**, including the **gate under real concurrency**: 8 simultaneous retries → 1 transaction; 6 simultaneous different-key entries of one receipt → exactly 1 recorded, 5 refused; 5 simultaneous submits → 1 history entry; 5 simultaneous import commits → each row once; 2 simultaneous completions of the same file → 1 kept. Also: direct uploads refused, signed reads for the right tenant only (forced download), no public URL, bucket refuses HTML and > 10 MB, internal notes hidden, no direct writes |
| Live route access (now including all intake pages and the download route) | Production build + real sessions | **25/25**: access matrix for every persona and every new page, real data on detail pages, other tenants get not-found with no data leak, download 303 for members, 404 for others, 401 when signed out |
| **Browser end-to-end** (`tests/routes/intake-e2e.live.test.ts`) | Production build + Chromium + real Supabase | **7/7** through the real forms: **double-clicking "submit" records once**; field errors with nothing recorded; real PDF stored and disguised program refused (and retry creates nothing); **XLSX import** of the fixture (3 imported, TOTAL row rejected); review by an accountant, approval by a reviewer, booking through the journal → **Posted**; correction loop visible to the client on a phone-sized screen; viewer cannot open the form |
| Regression: accounting live 10/10; cross-tenant and TOTP live 32/32 | Real Supabase | Pass |
| Mutation checks | PGlite | Removing the duplicate-receipt index → 1 test fails. Breaking request-key uniqueness → 6 tests fail. Removing the same-file index is not caught offline (explicit checks also exist); the live simultaneous-completion test covers it. Probe files deleted. |
| Cleanup | Real Supabase | 0 test clients, 0 temporary users, 0 documents, 0 stored files left (only DEMO-A/DEMO-B) |

## 3. Problems found and fixed during this phase

| Problem | Found by | Fix |
|---|---|---|
| The freeze-after-submit guard compared rows including a **generated column**, which is NULL inside BEFORE triggers, so every status change after submission was refused | DB tests (8 failures) | The derived column is excluded from the comparison |
| `text[] || 'literal'` was parsed as an array literal in the profile completeness check | DB test | Typed literals |
| Two return columns of `begin_document_upload` had the same names as table columns (ambiguous inside PL/pgSQL) | Review before running | Renamed outputs |
| A pending (never finished) upload could have blocked a real upload of the same file | Design review | Only completed uploads count for duplicate detection |
| Direct API uploads would have bypassed the server's byte checks | Design review | Removed the storage insert policy. Only the server writes bytes, to the path the user's authorized call created. |
| Schema lint: IMMUTABLE functions calling STABLE ones; an untyped empty array; unused session variables | `supabase db lint` | Follow-up migration `160500` (applied migrations are never edited). Lint is clean. |
| Import page showed the wrong "type" after checking rows (React resets forms after an action) | Browser e2e screenshot | The mapping form re-mounts with the saved values |
| Uploads chosen before the page finished loading were lost (the e2e test hit this) | Browser e2e | Tests wait for the page to settle. Real users rarely hit it; noted under §4. |

## 4. Not done, limitations and risks

| Item | Status |
|---|---|
| Malware scanning of uploads | **Open (R-12).** Byte checks block executables, web content and macros, but this is not antivirus. |
| Tax tagging (VAT classes, ATC codes), purchase/sales registers, VAT summaries | Later phase, after CPA sign-off. VAT/withholding are only recorded *as stated*. |
| Payroll, inventory computations | Later modules. They extend the canonical transaction via `attributes` and lines. |
| Requests for information (RFI) page | Still a placeholder (doc 03 W3) |
| Email notifications to clients | Not built (no SMTP yet) |
| Upload size | 10 MB per document, 5 MB per import file (`next.config.ts` allows 11 MB request bodies). Larger files would need direct-to-storage signed uploads with a server-side check afterwards. |
| Storage files of deleted (soft-deleted) documents | Kept. A retention/purge policy is needed (doc 11). |
| Phone uploads chosen before the page finishes loading | Can be lost (the user picks again). An improvement for later. |
| Data Privacy Act | Client documents and TINs are now stored in the dev project (Seoul region); **only synthetic data was used.** The production region and DPA review are still open (D-04). |

## 5. Acceptance criteria

- [x] Structured client forms and submission workflows for business profiles, customers, suppliers, supporting documents and generic transaction drafts
- [x] Required-field validation in the browser, in the server and in the database
- [x] Draft, submitted, needs-correction, reviewed, approved, rejected and posted statuses
- [x] Private document upload with permission checks; file limits; malicious types refused
- [x] CSV/XLSX import with column mapping, preview, duplicate detection, row-level errors and summaries
- [x] Accountant feedback and resubmission
- [x] Submission tracking and audit events
- [x] Canonical schemas reusable by later modules
- [x] Incomplete or unverified submissions are never posted automatically
- [x] Tests for file limits, invalid input, malicious file types, duplicate imports, permissions and cross-tenant isolation
- [x] **Gate:** one valid submission recorded once and never duplicated on retry, proven live under simultaneous retries
- [ ] Owner approval of this report
