# 12 — Risks, Assumptions, Open Questions, and Implementation Roadmap

## 1. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-01 | Tax rules are encoded wrongly and produce incorrect returns | Medium | **High** | Versioned rule sets, accountant sign-off (SoD-3), golden test cases per form, and reviewer approval of every return |
| R-02 | BIR forms, ATCs or DAT structures change mid-year (as with 7.3 → 7.4 and new ATCs in 2025) | High | High | Rule and spec registry with effective dates; a monthly BIR issuance watch, owned by the Firm |
| R-03 | Official DAT specifications are unobtainable or incomplete | Medium | High | M16 is blocked until they are obtained; no reverse engineering |
| R-04 | Cross-tenant data leak | Low (with tests) | **Critical** | RLS on every table, composite foreign keys, pgTAP isolation tests in CI, private storage |
| R-05 | Service-role key leaks | Low | Critical | Server-only module, secret scanning, key rotation runbook |
| R-06 | The platform is construed as CAS/CBA or invoicing software and triggers BIR registration or e-invoicing obligations for clients | Medium | High | Decisions D-01 and D-02 with tax counsel; MVP limited to recording, not issuance |
| R-07 | The BIR's own systems are unavailable at deadlines (eBIRForms outage noted in Aug 2026) | Medium | Medium | The platform does not depend on BIR systems; it tracks the manual fallback per BIR advisories |
| R-08 | Duplicate postings from retries or double clicks | Medium | High | Idempotency keys, unique constraints, row locks |
| R-09 | Data privacy non-compliance (hosting outside the PH, NPC requirements) | Medium | High | Legal review (decision D-04) before production data is loaded |
| R-10 | Scope creep (payroll, inventory, e-invoicing) delays the core | High | Medium | Phased roadmap with explicit gates |
| R-11 | No local Docker, so RLS and migration tests cannot run locally | **Current** | Medium | Install Docker Desktop, or use a dedicated dev Supabase project (decision D-12) |
| R-12 | Malicious uploads | Medium | Medium | MIME allowlist, size limits; malware scanning is to be designed (open question Q-14) |
| R-13 | Single-person dependency for accountant sign-off | Medium | Medium | At least two signatories (Q-03) |
| R-14 | Secondary-source information is wrong (several conflicts found in Phase 1) | High | High | Only V-P items, signed off by the accountant, are encoded |
| R-15 | If clients must register the platform (D-02), each **major enhancement** (a financial-impact change) needs **re-registration per client** (RMO 9-2021 §V.8). This conflicts with continuous deployment, and an unregistered upgrade brings penalties. | Medium | **High** | Release register, financial-impact flag, per-client version pinning (D-16); counsel question doc 13 §7 Q3 |
| R-16 | Ending a provider contract **automatically cancels** the client's system registration (RMO 9-2021 §V.6). Clients need notice procedures and data hand-back. | Medium | Medium | Offboarding workflow, record export, contract terms |
| R-17 | Scope from D-03 (all forms) lengthens the tax phases and needs many more golden test cases | High | Medium | Deliver in waves; each form is activated independently |

## 2. Assumptions (to be confirmed)

| ID | Assumption |
|---|---|
| A-01 | There is exactly one Firm (single firm, many clients). Multi-firm SaaS is out of scope. |
| A-02 | The platform does **not** file returns with or pay the BIR. Staff use eFPS, eBIRForms or other BIR channels outside the platform. |
| A-03 | The platform does **not** issue client sales invoices in the MVP. |
| A-04 | Clients keep their registered books of accounts outside the platform, or the platform's printouts serve as loose-leaf books. This depends on decision D-02. |
| A-05 | PHP only; foreign-currency transactions are recorded at their PHP equivalent. |
| A-06 | The expected scale is under 200 clients and under 50 staff users in the first year. |
| A-07 | English-language UI. Filipino is not required. |
| A-08 | The Firm has a qualified accountant (CPA) available to sign off rules and golden cases. |
| A-09 | Official BIR validation modules run on a Firm Windows workstation. |
| A-10 | Staging and development use synthetic data only. |

## 3. Open questions

| ID | Question | Owner |
|---|---|---|
| Q-01 | What is the accountant's preliminary form list, which the master instructions mention as "previously supplied"? Engineering has not received it. | Owner / accountant |
| Q-02 | Which client types are in the pilot (e.g. VAT corporations, non-VAT sole proprietors on 8%)? | Owner |
| Q-03 | Who are the named tax-rule signatories, and what are their credentials? | Owner |
| Q-04 | Which returns and DAT files are in the MVP? (Proposal in doc 08 §5 item 9.) | Accountant |
| Q-05 | Does 1701-MS replace 1701 or 1701A for Micro and Small individuals? | Accountant |
| Q-06 | Status of the optional monthly 2550M filing? | Accountant |
| Q-07 | Percentage tax rate and VAT threshold currently in force? | Accountant |
| Q-08 | Rounding rules per form? | Accountant |
| Q-09 | Retention period for books and records? | Accountant / legal |
| Q-10 | Should entry numbers be gapless, and are they per fiscal year or per book (journal)? | Accountant |
| Q-11 | Policy for prior-period corrections: an adjusting entry in the current period, or reopen and amend? | Accountant |
| Q-12 | Must each client approve every return before filing, or can it be waived per engagement? | Owner |
| Q-13 | Does the Firm need its own NPC registration, a DPO, or a DPA template for clients? | Legal |
| Q-14 | Is malware scanning of uploads required? Which approach and budget? | Owner |
| Q-15 | Interpretation of e-invoicing coverage item 4 for CAS/CBA without invoicing (doc 10, E-2)? Now consolidated in doc 13 §7, questions 1–6. | Tax counsel / BIR |
| Q-16 | Git remote. **Deferred; the owner will provide it.** | Owner |
| Q-17 | Is the platform operator the same legal entity as the accounting firm? This changes who signs the RMO 9-2021 Annex E joint sworn statement and who carries "TSP" obligations (doc 13 §5). | Owner |

## 4. Decision register

Status values: **APPROVED** (the owner decided), **PENDING VERIFICATION** (needs external confirmation before it can be decided), **DEFERRED** (the owner will decide later), **PROPOSED** (awaiting an owner or accountant decision).

| ID | Decision | Status (as of 2026-10-10) | Detail | Approver |
|---|---|---|---|---|
| **D-01** | Will the platform issue client sales invoices or e-invoices? | **APPROVED: No, for the initial release** | The owner accepted the recommendation. Invoices are issued outside the platform. The platform records and ingests externally issued invoices, including e-invoice data in the future. Revisit only through a new decision, because issuing invoices brings the RMC 98-2026 obligations (PTI, EIS certification). | Owner |
| **D-02** | Must the platform be registered as clients' CAS / CBA / component, or under another category? | **PENDING VERIFICATION** | See [doc 13](13-d02-registration-research.md). RMO 9-2021 expressly lists systems that record sales and purchases and generate BIR reports as CAS/CBA "components", and expects third-party providers to co-sign a joint sworn statement. **No exemption is assumed.** Six questions are queued for tax counsel or the BIR (doc 13 §7). In the meantime, design constraints in doc 13 §6 apply. | Owner + accountant + tax counsel (possibly a BIR confirmation) |
| **D-03** | Form and DAT scope | **APPROVED: all forms in the registry, so clients have choices** | Every form in doc 08 §3 (F-01 to F-25) and every DAT type in doc 09 is in scope. Each form still activates only after its version is verified, its rule set is signed off, and its accountant golden cases pass. Delivery is in **waves** (§5). | Owner |
| **D-04** | Hosting | **DEFERRED: owner will set up hosting on Cloudflare later** | App hosting on Cloudflare (see doc 11 §2a). Still open: database hosting and region (Supabase region or other), and the RA 10173 clearance for any hosting outside the Philippines. | Owner + legal |
| D-05 | Where the official BIR modules run | PROPOSED | A dedicated Firm Windows workstation | Owner |
| D-06 | Tax-rule sign-off policy (who signs, two-person rule) | PROPOSED | Author ≠ signatory; at least 2 named signatories | Owner + accountant |
| D-07 | Mandatory client approval before filing | PROPOSED | Yes, by default | Owner |
| D-08 | Prior-period correction policy | **IMPLEMENTED DEFAULT (Phase 5), pending accountant confirmation** | Adjusting entry in the current period by default; reopening only by manager | Accountant |
| D-09 | `firm_admin` has no implicit access to financial data | PROPOSED | Yes (SoD-5) | Owner |
| D-10 | Gapless entry numbering | **IMPLEMENTED DEFAULT (Phase 5), pending accountant confirmation** | Yes, per client per fiscal year | Accountant |
| D-11 | MFA for client users | PROPOSED | Mandatory for `client_owner`; optional for other client roles | Owner |
| D-12 | Development database | **APPROVED (2026-10-10): hosted Supabase dev project** `yjbkhehsznednsutewyq` | Development and testing only, with synthetic data. Local Docker is optional for faster resets. Staging and production will be **separate** projects. | Owner |
| D-13 | Payroll and inventory phases | PROPOSED | After the core and tax MVP. With D-03, payroll forms (1601-C, 1604-C, 2316) arrive in a later wave. | Owner |
| D-14 | Budget envelope (doc 11) | PROPOSED; needs re-estimating for Cloudflare | Re-estimate once D-04 details are known | Owner |
| D-15 | Git remote and repository | **DEFERRED: owner will provide later** | Phase 2 needs it for CI | Owner |
| D-16 | Release management model for financial-impact changes (doc 13 §6.3) | PROPOSED; depends on D-02 | Semantic versions, a financial-impact flag, a release register, and per-client version pinning | Owner + counsel |

## 5. Implementation roadmap (proposed; each phase gated by approval)

| Phase | Title | Main modules | Key exit criteria | External prerequisites |
|---|---|---|---|---|
| **1** | Requirements, research, architecture | — | This documentation approved | — |
| 2 | Project foundation *(as instructed 2026-10-10)* | M00 | Next.js/TS setup, Supabase clients, env validation, lint, format, typecheck, tests, CI, error and logging foundation, migration workflow, setup docs. **Delivered: see PHASE-2-REPORT.md** | — |
| 3 *(owner numbering; was 2b)* | Identity, tenancy and audit **(delivered 2026-10-10, see PHASE-3-REPORT.md)** | M01, M02 | Auth with MFA; memberships; client assignments; audit log; RLS helper functions; pgTAP isolation tests passing; release/version register scaffold (D-16) | **D-12 (Docker), D-15 (Git remote)**; firm questionnaire Part A (roles, access, MFA) |
| 3 | Client master and document vault | M03, M04, M05 | Effective-dated profiles; private storage with RLS; RFI flow; cross-tenant storage tests passing | Q-02 |
| 4 | Ledger core | M06, M07, M08, M10 | Chart of accounts; periods; posting functions; invariants I-1 to I-10 proven by tests; reversal | D-08, D-10, Q-10 |
| 5 | Subledgers and period close | M09, M11, M19 | Sales and purchase tax tagging; close and lock; import staging | ATC subset confirmed |
| 6 | Financial reporting | M12, M18 (part) | TB, GL, BS and IS tie-out tests; books printouts | B-02 format |
| 7 | Tax rule registry and compliance calendar | M13, M15 | Rule-set versioning and sign-off workflow; calendar from approved profiles | D-06, signed-off rule data |
| 8 | Tax return working papers, **wave A**: quarterly business returns | M14 | 2550Q, 2551Q, 1701Q, 1702Q, 0619-E/F, 1601-EQ, 1601-FQ, 0605 pass accountant golden cases; staleness detection | Golden cases; verified form versions |
| 8b | Tax return working papers, **wave B**: annual returns | M14 | 1701, 1701A, 1701-MS, 1702-RT/EX/MX, 1604-E, 1604-F (+ 1700 if needed) | Same |
| 8c | **Wave C**: payroll-linked forms and certificates | M14, M17, M20 | 1601-C, 1604-C, 2316, 2307, 2306, 1600-VT/PT, 2550M if confirmed | D-13, payroll module |
| 9 | DAT generation and validation register (all types in doc 09) | M16, M17 | Files pass the **official** BIR modules on synthetic data; results recorded | Spec annexes obtained (doc 09 §4) |
| 10 | Client portal completion | M18 | Approvals, dashboards, notifications | D-07 |
| 11 | Production hardening and deployment | M23 | Restore drill passed; security review; runbooks; monitoring | D-04 legal clearance, D-14 |
| 12+ | Optional: payroll, inventory, e-invoice import, e-invoicing | M20–M22 | Separate approvals | D-01, D-13 |
