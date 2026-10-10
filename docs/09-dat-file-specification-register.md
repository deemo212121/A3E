# 09 — DAT / Alphalist File Specification Register

> **Status: no field-level file specification has been obtained yet.** This register tracks which specifications exist, where they are published, and what must be obtained before generators (module M16) are built. **No DAT generator may be built from reverse-engineered or third-party layouts** (master rule 4).

## 1. Register

| ID | File | Attached to / purpose | Governing issuance (as found) | Official tool / validator | Field-level spec obtained? | Spec location to obtain | Status |
|---|---|---|---|---|---|---|---|
| D-01 | **QAP**: Quarterly Alphalist of Payees, expanded withholding | 1601-EQ | RMC 7-2021 (v7.0) → RMC 61-2024 (v7.3) → **RMC 15-2025 (v7.4)** | Alphalist Data Entry & Validation Module **v7.4** | **No** | RMC 15-2025 **Annex A (file structures)** and **Annex B (naming convention)**; BIR Downloadables | OPEN |
| D-02 | QAP, final withholding | 1601-FQ | Same as D-01 | Same | No | Same | OPEN |
| D-03 | Annual alphalist, compensation | 1604-C | Same as D-01 | Same | No | Same | OPEN |
| D-04 | Annual alphalist, expanded withholding | 1604-E | RMC 7-2021 (v7.0 scope). RMC 15-2025 deadlines name 1604C, 1604F, 1601EQ and 1601FQ but not 1604E; **confirm whether 1604-E is still in the module** | Same | No | Same | OPEN |
| D-05 | Annual alphalist, final withholding | 1604-F | Same as D-01 | Same | No | Same | OPEN |
| D-06 | Monthly alphalist of payees (VAT/PT withheld) | 1600-VT / 1600-PT | RMC 7-2021 | Same | No | Same | OPEN (likely out of MVP) |
| D-07 | **SAWT**: Summary Alphalist of Withholding Taxes (payee side) | 1701Q, 1701, 1702Q, 1702, 2550Q, 2551Q | RR 2-2006 as amended; RR 1-2014 modes; RR 2-2015 (V-S) | Reportedly the same Alphalist module (secondary); **confirm** | No | Module annexes / job aids | OPEN |
| D-08 | **SLSP**: Summary List of Sales | 2550Q | RR 1-2012 (mandatory; V-S); RMO 4-2003 processing; RR 16-2005 §4.114-3 (V-S) | **RELIEF** Data Entry / Validation module (version unknown) | No | BIR Downloadables (RELIEF); the RMC referenced by RMO 4-2003 | OPEN |
| D-09 | SLSP, Summary List of Purchases | 2550Q | Same as D-08 | Same | No | Same | OPEN |
| D-10 | SLSP, Summary List of Importations | 2550Q | Same as D-08 | Same | No | Same | OPEN (likely out of MVP) |
| D-11 | MAP: Monthly Alphalist of Payees (final withholding) | 1601-FQ / historical | RR 1-2014 mentions MAP | Unknown | No | — | OPEN; confirm whether still required |
| D-13 | **Standard Audit File (SAF)**: soft copy of computerized books of accounts | Annual ORUS registration of computerized books (RMC 91-2024) | RMO 9-2021 §III.13 and §V (requires SAF per RR 16-2006 in relation to RR 9-2009; "PDF … deemed unacceptable") (V-P) | BIR audit tools (unspecified) | No | RR 16-2006 / RR 9-2009 texts and any SAF technical spec | OPEN. Needed if D-02 → CBA. |
| D-12 | EIS e-invoice JSON | E-invoicing (doc 10) | RMC 98-2026 §IV.6 (V-P) | **EIS Certification Portal** `https://eis-cert.bir.gov.ph` | No | EIS certification portal technical specifications | OPEN; out of MVP unless D-01 |

## 2. Submission channels (as found; to confirm)

| Channel | Used for | Status |
|---|---|---|
| eFPS attachment | Alphalists for eFPS filers | V-S (RR 1-2014) |
| BIR eSubmission (web/email) | Alphalists, SAWT, QAP, SLSP | V-S. The eSubmission facility sends "error reply messages" (S-09, V-P), so its replies must be captured as validation results. |
| DVD-R with scanned 2307 PDFs | Under RR 2-2015, for Large Taxpayers | V-S; current status U |

## 3. What the platform will and will not claim

| Stage | Platform label | Meaning |
|---|---|---|
| Generated | "Generated (spec vX.Y)" | Built by our generator against the registered spec version |
| Internal pre-check passed | "Pre-check passed — not BIR validation" | Our checks only: totals reconcile to the return and ledger, TINs well-formed, ATCs valid for the period |
| Official module result recorded | "Validated with BIR module vX.Y (log attached)" | Staff ran the official module and uploaded its output |
| eSubmission reply recorded | "BIR eSubmission reply: accepted / error" | The reply email or screen was captured and attached |

## 4. Acquisition checklist (before module M16 starts)

1. Download the current Alphalist Data Entry & Validation Module from BIR Downloadables. Record the version and download date, and check whether there is a release later than v7.4.
2. Obtain the **RMC 15-2025 Annexes A and B**, or any later superseding annexes. Store them in `docs/specs/bir/`, record their SHA-256, and register each in `file_specs`.
3. Obtain the current RELIEF module and its SLSP file-structure documentation.
4. Have the accountant confirm which files are in MVP scope (proposed: QAP for 1601-EQ, SAWT, SLSP sales and purchases).
5. Generate **synthetic** test files. Run them through the **official** modules on a Firm workstation and keep the outputs as golden fixtures for automated regression tests.
6. Identify the module's control-total, header and footer rules and naming conventions from the annexes. Do not infer them.
