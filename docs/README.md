# Philippine Accounting Services Platform — Documentation

**Status:** Phase 1 (Requirements, research, and architecture) — submitted for review on 2026-10-10. Nothing in this folder is approved yet.

**Rule for every document here:** None of these documents claims tax or regulatory compliance. Tax rules, form eligibility, deadlines and file specifications are recorded as *research findings* together with their sources and verification status. A qualified accountant must confirm them before they are encoded in software.

| # | Document | Purpose |
|---|---|---|
| 01 | [Project overview and business requirements](01-project-overview-and-requirements.md) | Scope, goals, functional and non-functional requirements |
| 02 | [User roles and permissions matrix](02-roles-and-permissions.md) | Who can do what |
| 03 | [Client-to-accountant workflows](03-client-accountant-workflows.md) | End-to-end process flows |
| 04 | [Module dependency map](04-module-dependency-map.md) | Modules and their build order |
| 05 | [Accounting transaction lifecycle](05-accounting-transaction-lifecycle.md) | Draft → posted → reversed, and the invariants that hold throughout |
| 06 | [Proposed PostgreSQL ERD](06-database-erd.md) | Proposed entities and constraints (design only; no tables created yet) |
| 07 | [Supabase security and tenant isolation](07-security-and-tenant-isolation.md) | RLS, authorization, storage, secrets, audit |
| 08 | [BIR compliance research matrix](08-bir-compliance-research-matrix.md) | Forms, versions, eligibility and sources, each with a verification status |
| 09 | [DAT / alphalist file specification register](09-dat-file-specification-register.md) | Electronic file formats and validation modules |
| 10 | [Electronic invoicing research](10-electronic-invoicing-research.md) | RR 11-2025, RR 26-2025, RMC 98-2026 and what they mean for the platform |
| 11 | [Deployment architecture and cost estimates](11-deployment-architecture-and-costs.md) | Environments, hosting, backups, preliminary costs |
| 12 | [Risks, assumptions, open questions, roadmap](12-risks-assumptions-questions-roadmap.md) | Risk register, decisions needed, phase plan |
| 13 | [D-02 registration research](13-d02-registration-research.md) | CAS / CBA / component registration: requirements by party (D-02 PENDING VERIFICATION) |
| ★ | [**Walkthrough: what to check, click by click**](WALKTHROUGH.md) | Start here to see and verify the system |
| — | [Phase 1 review report](PHASE-1-REVIEW-REPORT.md) | Summary for approval (revision 2) |
| — | [Firm questionnaire](firm-questionnaire.md) | Questions for the accounting firm |
| — | [Phase 2 report](PHASE-2-REPORT.md) | Project foundation: checks run and results |
| — | [Phase 3 report](PHASE-3-REPORT.md) | Auth, tenancy and isolation: live cross-tenant results |
| — | [Phase 4 report](PHASE-4-REPORT.md) | Shell and navigation: live route-access results |
| — | [Phase 5 report](PHASE-5-REPORT.md) | Double-entry engine: accounting, concurrency and duplicate-prevention results |
| — | [Phase 6 report](PHASE-6-REPORT.md) | Client portal and data intake: retry-safety gate, uploads, imports, live and browser test results |
| — | [Phase 7 report](PHASE-7-REPORT.md) | Sales and receivables: invoice records, receipts, credit notes, posting rules, reconciliation |
| sales | [Posting rules](sales/POSTING-RULES.md) | Sales journal entries, rounding, controls (pending CPA review) |
| intake | [Canonical intake schema](intake/CANONICAL-INTAKE-SCHEMA.md) | Transactions, customers/suppliers, documents, imports, workflow and retry rules (Phase 6) |
| accounting | [Test scenarios (for accountant sign-off)](accounting/TEST-SCENARIOS.md) · [Starter chart of accounts (PROPOSED)](accounting/COA-TEMPLATE-PROPOSED.md) · [Review of the Firm's client workbooks](accounting/FIRM-WORKBOOK-REVIEW.md) | Phase 5 |
| design | [Design system](design/DESIGN-SYSTEM.md) · [Information architecture and route access](design/INFORMATION-ARCHITECTURE.md) | Phase 4 (PROPOSED) |
| security | [Access control](security/ACCESS-CONTROL.md) · [Runbook: recovery and disable](runbooks/ACCOUNT-RECOVERY-AND-DISABLE.md) · [Supabase project setup](setup/SUPABASE-AUTH-SETUP.md) | Phase 3 security docs |
| setup | [Local development](setup/LOCAL-DEVELOPMENT.md) · [Environments](setup/ENVIRONMENTS.md) · [Migrations](setup/MIGRATIONS.md) · [Project structure](setup/PROJECT-STRUCTURE.md) · [Troubleshooting](setup/TROUBLESHOOTING.md) | Developer setup |

## Verification status legend (used in docs 08–10)

| Code | Meaning |
|---|---|
| **V-P** | Verified against a primary BIR document (the full text or the BIR-published digest on `bir.gov.ph` / `bir-cdn.bir.gov.ph`) that was actually read during Phase 1 |
| **V-S** | Corroborated only by reputable secondary sources (Big-4 / law-firm tax alerts). The primary text has not yet been read. |
| **U** | Unverified. Based on general knowledge or a single secondary source, or the sources conflict. |
| **OPEN** | Not found. Someone must obtain it before implementation. |

Nothing below **V-P** may be encoded as a production rule. Even a **V-P** item needs an accountant's sign-off.
