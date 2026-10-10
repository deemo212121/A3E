# 01 — Project Overview and Business Requirements

## 1. Context

One accounting services firm (the **Firm**) provides bookkeeping, financial reporting and tax compliance services to many client businesses (**Clients**). Today this work is assumed to run on spreadsheets, email and manual BIR form preparation. The platform replaces that with:

- a structured **client portal**, where clients submit source documents, answer requests and approve outputs;
- a **staff portal**, where Firm staff do the bookkeeping;
- a **review and approval workflow**, where a reviewer or manager signs off before anything is posted or filed;
- a central **double-entry ledger** for each client;
- **financial reports**;
- **configurable tax computation** and BIR return working papers;
- **BIR electronic file (DAT) generation**, with pre-validation;
- a secure production deployment.

## 2. Client profile variability

The platform must support each of these dimensions per client and over time. Classifications change, so every dimension is stored with effective dates.

| Dimension | Values (preliminary — accountant to confirm the list) |
|---|---|
| Legal form | Sole proprietor (individual), one-person corporation, domestic corporation, partnership. Others are TBD. |
| Business tax | VAT-registered; non-VAT (percentage tax); exempt |
| Individual income tax regime | Graduated rates (itemized or OSD) or the 8% option, where eligible. Elected per year; see doc 08. |
| Corporate income tax | Regular, MCIT, special or exempt regimes. The regime list needs accountant confirmation. |
| EOPT classification (RR 8-2024) | Micro / Small / Medium / Large |
| Withholding agent obligations | Compensation (payroll), expanded, final, and VAT/percentage-tax withholding |
| Inventory | None / periodic / perpetual |
| Payroll | None / in-scope (a separate later module) |
| Fiscal period | Calendar year or fiscal year |
| Branches | Head office (000) plus branch codes |
| Books of accounts | Manual, loose-leaf, or CAS/CBA (decision D-02 affects this) |
| E-invoicing coverage | Whether the client is covered by RR 11-2025 / RMC 98-2026 (see doc 10) |

## 3. Functional requirements (FR)

Priority: **M** = must have for the MVP, **S** = should have, **C** = could have / later.

### Tenancy and access
- **FR-01 (M)** The Firm manages many Clients. Each Client's data is isolated from every other Client's.
- **FR-02 (M)** Firm staff see only the Clients they are assigned to. Firm admins and managers can see all Clients.
- **FR-03 (M)** Client users see only their own Client or Clients. One person may belong to several Clients, for example an owner of two corporations.
- **FR-04 (M)** Staff accounts require multi-factor authentication. Client accounts should use it as well.

### Client master data
- **FR-05 (M)** Each client has a taxpayer profile: TIN, branch code, RDO, registered name and address, tax types, and Certificate of Registration (BIR Form 2303) details. All of these are effective-dated.
- **FR-06 (M)** The client's compliance calendar is generated from its tax registrations and the rule tables. The rules are data, not hard-coded logic.

### Client portal
- **FR-07 (M)** Clients upload source documents (invoices, receipts, 2307s, bank statements, payroll records) to private storage. Each upload carries a period, a category and an integrity checksum.
- **FR-08 (M)** Staff send structured information requests, clients answer them, and every request has a status.
- **FR-09 (S)** Clients view approved financial statements and tax working papers.
- **FR-10 (S)** Clients formally approve a tax return before it is filed, and the approval is recorded with an audit trail.

### Bookkeeping
- **FR-11 (M)** Each client has a chart of accounts, seeded from a template the Firm maintains.
- **FR-12 (M)** Staff record journal entries and subledger transactions (sales, purchases, cash receipts, cash disbursements) and link them to source documents.
- **FR-13 (M)** Every posted entry balances. Posting is idempotent: retrying the same post cannot create a duplicate.
- **FR-14 (M)** A posted entry is never edited or deleted. Corrections go through reversal or adjusting entries.
- **FR-15 (M)** Periods move through open → soft-closed → locked. Posting into a locked period is rejected by the database.
- **FR-16 (M)** A counterparty registry stores each supplier's and customer's TIN, registered name and address. Withholding, SLSP and alphalists all depend on it.
- **FR-17 (S)** Staff can import transactions in bulk from CSV or Excel. Imports run through a staging and validation step before anything posts.
- **FR-18 (C)** Bank reconciliation.

### Review and approval
- **FR-19 (M)** Maker–checker control: whoever prepares an entry, return or file cannot approve it.
- **FR-20 (M)** Each reviewer action is recorded with a comment, an actor and a timestamp.

### Reporting
- **FR-21 (M)** Trial balance, general ledger, balance sheet, income statement and journal listings, for any period and as of any date.
- **FR-22 (S)** Books-of-accounts printouts (general journal, general ledger, sales journal, purchase journal, cash receipts book and cash disbursements book) in the formats the client's registered books require. The format must be confirmed (doc 08, item B-series).
- **FR-23 (C)** Cash flow statement and statement of changes in equity.

### Tax
- **FR-24 (M)** Tax rules are stored as **versioned rule sets**. Each rule set carries its legal source, effective dates, verification status and the accountant who signed it off. No rule activates without sign-off.
- **FR-25 (M)** The tax engine produces return working papers that the Firm then transcribes or files through eFPS or eBIRForms. The platform **does not file with the BIR directly**; no public filing API was identified.
- **FR-26 (M)** Withholding tax is tracked per transaction by alphanumeric tax code (ATC), and 2307 data is generated from that tracking.
- **FR-27 (M)** Each return records its filing details: date filed, filing reference or confirmation email, payment proof, and any amendments.

### BIR electronic files
- **FR-28 (M)** The platform generates DAT files (QAP, SAWT, SLSP, annual alphalists) according to the **official BIR file structures**. Those structures must be obtained first (doc 09).
- **FR-29 (M)** The platform runs its own pre-validation, then records the result from the **official BIR validation module**, which is run outside the platform. The platform must not claim a file is "BIR-validated" unless that official result has been recorded.

### Audit
- **FR-30 (M)** An append-only audit log covers financial, approval, permission, export and document-access events.

## 4. Non-functional requirements (NFR)

| ID | Requirement |
|---|---|
| NFR-01 | **Accuracy:** money is stored as `numeric(18,2)`, or `numeric(18,4)` for unit costs where needed. Floating point is never used for money. Rounding rules are explicit and configurable per rule set. |
| NFR-02 | **Security:** RLS on every tenant table, server-side authorization on every mutation, private storage, and no privileged secrets on the client side (doc 07). |
| NFR-03 | **Auditability:** posted data is immutable, and the audit log is append-only. |
| NFR-04 | **Data privacy:** comply with RA 10173 (Data Privacy Act). Legal confirmation is required for NPC registration, cross-border hosting and the retention schedule. |
| NFR-05 | **Retention:** keep books and records for the period the Tax Code and current regulations require. **The exact period needs accountant confirmation**; EOPT-era rules are understood to have changed it, but this was not verified in Phase 1. |
| NFR-06 | **Recoverability:** daily backups plus point-in-time recovery in production. The restore procedure must be documented and rehearsed. |
| NFR-07 | **Performance:** a trial balance for one client-year of about 50k lines returns in under 3 s. |
| NFR-08 | **Testability:** automated tests cover posting invariants, RLS isolation and tax computations, the last of these against accountant-supplied golden cases. |
| NFR-09 | **Synthetic data only** outside production. |
| NFR-10 | **Locale:** PHP currency, Asia/Manila time zone, and Philippine date formats on outputs. Timestamps are stored in UTC. |

## 5. Out of scope for the MVP (proposed — needs owner approval)

- Direct filing to eFPS or eBIRForms. No public API was identified.
- Issuing clients' sales invoices, which would make the platform an e-invoicing system (decision D-01, doc 10).
- Payroll computation (proposed as a later phase).
- Perpetual inventory costing (proposed as a later phase).
- Multi-currency beyond recording a foreign-currency amount and its PHP equivalent.
- Local business tax and real property tax.
