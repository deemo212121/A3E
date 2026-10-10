# 08 — BIR Compliance Research Matrix

> **Research findings only. These are not tax advice and not compliance claims.**
> Research date: **2026-10-10**. Status codes (**V-P / V-S / U / OPEN**) are defined in [README](README.md).
> **No accountant-supplied form list was provided to engineering in Phase 1.** When one is supplied, it will be reconciled against this matrix as *preliminary input* and differences will be logged here.

## 1. Primary sources read in Phase 1

| Ref | Issuance | Issued | What it establishes (as read) | URL | Status |
|---|---|---|---|---|---|
| S-01 | RR 11-2025 (BIR digest) | 2025-02-27 | Mandatory e-invoicing for (a) e-commerce, (b) taxpayers under the Large Taxpayers Service, (c) Large Taxpayers under RA 11976 / RR 8-2024, (d) CAS/CBA users with e-invoicing and other invoicing software. Micro taxpayers are exempt. Electronic sales reporting applies once the BIR system exists. Additional deduction for the cost of an electronic sales reporting system. | https://bir-cdn.bir.gov.ph/BIR/pdf/RR%2011-2025%20Digest.pdf | V-P (digest) |
| S-02 | RR 26-2025 (BIR digest) | 2025-10-16 | Extends the e-invoice issuance deadline to **2026-12-31** for groups 1–4; the CIR may extend further | https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2026-2025%20Digest.pdf | V-P (digest) |
| S-03 | RMC 98-2026 (full text, redacted scan) | 2026-09-22 | E-invoice definition and criteria, JSON format for the EIS, PTI Electronic Invoice, EIS Certification within 6 months, Excel/Word invoices not valid, corrections by credit note or new invoice, downtime fallback | https://bir-cdn.bir.gov.ph/BIR/pdf/RMC%20No.%2098-2026%20redacted.pdf | V-P |
| S-04 | BIR press release PR101SEP2326 | 2026-09-23 | Confirms S-03; says e-invoicing and e-sales reporting are separate, with e-sales reporting to follow | https://bir-cdn.bir.gov.ph/BIR/pdf/PR101SEP2326.pdf | V-P |
| S-05 | RMC 49-2025 (BIR digest) | 2025-05-09 | eBIRForms v7.9.5 includes **1702Q January 2018 (ENCS)** and **2550Q April 2024 (ENCS)**. 2550Q is due the 25th day after quarter close; 1702Q within 60 days after each of the first 3 quarters. Lists new ATCs for 0605, 1600-VT, 1601-EQ and 1601-FQ. | https://bir-cdn.bir.gov.ph/BIR/pdf/RMC%20No.%2049-2025%20Digest_v2.pdf | V-P (digest) |
| S-06 | RMC 20-2026 (BIR digest) | 2026-03-16 | CY2025 annual ITR guidelines. Latest eBIRForms versions: **1700v2018, 1701v2018, 1701A, 1702RTv2018C, 1702EXv2018C, 1702MXv2018C**. eFPS returns: 1700, 1701, 1701A, 1702RT, 1702-EX, 1702-MX. Covers manual-filing exceptions, e-payment channels, and the eLounge limit for tax practitioners (RMO 39-2024). | https://bir-cdn.bir.gov.ph/BIR/pdf/RMC%20No.%2020-2026%20Digest.pdf | V-P (digest) |
| S-07 | RMC 7-2021 (BIR digest) | 2021-01-08 | Alphalist Data Entry & Validation Module v7.0 covers 1600-PT, 1600-VT, 1601-FQ, 1601-EQ, 1621, 1604-C, 1604-E and 1604-F. File structures, naming convention and job aids are in Annexes A–C. | https://bir-cdn.bir.gov.ph/local/pdf/RMC%20No.%207-2021.pdf | V-P (digest) |
| S-08 | RMC 61-2024 (BIR digest) | 2024-05-13 | Module v7.3; revised file structures and naming in Annexes A and B | https://bir-cdn.bir.gov.ph/BIR/pdf/RMC%20No.%2061-2024.pdf | V-P (digest) |
| S-09 | RMC 15-2025 (BIR digest) | 2025-02-25 | Module **v7.4** with new ATCs and updated rates. Own-extract-program users must follow the revised file structures and naming in **Annexes A and B**. | https://bir-cdn.bir.gov.ph/BIR/pdf/RMC%20No.%2015-2025%20Digest.pdf | V-P (digest) |

### 1a. Primary sources added for D-02 (2026-10-10; analysis in [doc 13](13-d02-registration-research.md))

| Ref | Issuance | Issued / effective | Establishes | Status |
|---|---|---|---|---|
| S-10 | RMO 9-2021 (full text) | 2021-02-01, effective immediately | CAS/CBA/component definitions; scope includes systems that record sales and purchases or generate BIR reports; taxpayer-user registers the system and gets an AC; third-party/TSP joint sworn statement (no-suppression attestation); major enhancement means re-registration; CBA soft copy in SAF | V-P (annexes not obtained) |
| S-11 | RMC 5-2021 (full text) | 2020-12-28, effective immediately | PTU replaced by registration plus an AC within 3 working days; post-evaluation against Annex B standards | V-P |
| S-12 | RR 7-2024 (digest outline) | 2024-04-11 | EOPT registration, preservation of books (§235) and invoicing (§§113, 237, 238) | V-P (outline only) |
| S-13 | RMC 91-2024 (digest) | 2024-08-14 | Books registered through ORUS with a QR stamp; computerized books registered annually within 30 days after year-end; loose-leaf within 15 days | V-P |
| S-14 | RMC 4-2026 (digest) | 2026-01-15 | ORUS registration of loose-leaf and computerized books is mandatory; deadline extensions for CY2025 books | V-P |

## 2. Secondary sources (not yet confirmed from primary text)

| Ref | Topic | Finding | Source(s) | Status |
|---|---|---|---|---|
| X-01 | RR 8-2024 taxpayer classification | Micro < ₱3M; Small ₱3M to < ₱20M; Medium ₱20M to < ₱1B; Large ≥ ₱1B gross sales. Effective 2024-04-27. Reclassification under RMO 37-2024. | [PwC Tax Alert 20](https://pwc.com/ph/en/tax/tax-publications/tax-alerts/2024/tax-alert-20.html), [Grant Thornton](https://www.grantthornton.com.ph/insights/articles-and-updates1/tax-notes/eopt-is-here-guidelines-for-classification-of-business-taxpayers/) | V-S (RR 8-2024 itself is cited in S-01 and S-03) |
| X-02 | Monthly VAT 2550M | From 2023-01-01, quarterly 2550Q (RMC 5-2023). RMC 52-2023 reportedly lets taxpayers *optionally* file 2550M. One source says EOPT removed 2550M. **The sources conflict.** | [KPMG](https://kpmg.com/ph/en/home/insights/2023/02/2550-m-no-more.html), [Forvis Mazars](https://www.forvismazars.com/ph/en/insights/tax-alerts/bir-rmc-05-2023), [batasnatin](https://batasnatin.com/laws/rmc-no-52-2023-clarifies-the-optional-filing-and-payment-of-monthly-vat-retur) | U |
| X-03 | 1701-MS (August 2024) | Annual ITR for individuals classified Micro or Small. Added to eBIRForms 7.9.6.0 by RMC 36-2026 (2026-04-28). RMC 37-2026 amends RMC 20-2026 to allow electronic filing. Tax advisory of 2026-08-17 says to move to v7.9.6.1. | [PwC Tax Alert 19 (2026)](https://www.pwc.com/ph/en/tax/tax-publications/tax-alerts/2026/tax-alert-19.html), [KPMG advisory](https://assets.kpmg.com/content/dam/kpmgsites/ph/pdf/InTAX/2026/BIR_eBIRFormsAdvisory_2026-08-17.pdf), [BIR 1701-MS guide](https://bir-cdn.bir.gov.ph/BIR/pdf/1701-MS%20Guide%20August%202024%20ENCS_Final.pdf), [RMC 36-2026](https://bir-cdn.bir.gov.ph/BIR/pdf/RMC%20No.%2036-2026.pdf) | V-S (primary links found, not read) |
| X-04 | 8% income tax option | For self-employed or professional individuals not VAT-registered, with gross sales or receipts ≤ ₱3M. 8% on the amount over ₱250k, in lieu of graduated rates and percentage tax. Elected annually. | [Grant Thornton](https://www.grantthornton.com.ph/insights/articles-and-updates1/lets-talk-tax/the-8-tax-for-self-employed-individuals/) | V-S |
| X-05 | Percentage tax rate | 3% after the CREATE 1% period ended 2023-06-30 | Secondary blogs only | U |
| X-06 | EOPT invoicing (RR 7-2024; RR 11-2024 transitory) | The VAT invoice is the primary sales document; the "official receipt" is no longer the sales evidence. RR 7-2024 sets minimum invoice information (also cited by S-03). | [Forvis Mazars](https://www.forvismazars.com/ph/en/insights/tax-alerts/ease-of-paying-taxes-act/implementing-rules-and-regulations-of-the-eopt-act), [MTF Counsel](https://mtfcounsel.com/2025/05/08/how-to-comply-with-the-birs-invoicing-requirements/) | V-S |
| X-07 | Alphalist submission modes | RR 1-2014: electronic submission is mandatory (eFPS attachment, eSubmission, email). RR 2-2015: SAWT via the data-entry module; scanned 2307s on DVD-R (mandatory for Large Taxpayers). RR 16-2021 reportedly amends this. | [Grant Thornton 2014](https://www.grantthornton.com.ph/alerts-and-publications/technical-alerts/tax-alert/2014/clarification-on-the-mode-of-submission-of-alphalist/), [Deloitte RR 2-2015](https://www2.deloitte.com/content/dam/Deloitte/ph/Documents/tax/ph-revenue-regulations-2-2015.pdf) | V-S (current status of the DVD-R rule is U) |
| X-08 | SLSP | Mandatory for VAT-registered taxpayers (RR 1-2012 cited). Quarterly; DAT via the RELIEF module; processing under RMO 4-2003; schema reportedly RR 16-2005 §4.114-3. | [SC e-Library RMO 4-2003](https://elibrary.judiciary.gov.ph/thebookshelf/showdocs/10/40320), vendor guides | U |
| X-09 | eAFS | RMC 46-2026 (2026-05-18): procedures for 2025 AFS via eAFS | [Grant Thornton](https://www.grantthornton.com.ph/technical-alerts/tax-alert/2026/extended-deadline-for-submission-of-2025-audited-financial-statements-and-other-required-attachments-to-the-annual-income-tax-return/), [DivinaLaw PDF](https://www.divinalaw.com/wp-content/uploads/2026/08/BIR-04-RMC-No.-46-2026.pdf) | V-S |
| X-10 | CAS / CBA registration | Acknowledgement Certificate instead of a Permit to Use, with post-evaluation (RMC 5-2021 is cited; the issuance number is inconsistent across sources). RMC 65-2025: new taxpayers choose manual, loose-leaf or computerized books. Loose-leaf books need a Permit to Use, and CAS/CBA need an Acknowledgement Certificate. | [Grant Thornton](https://www.grantthornton.com.ph/insights/articles-and-updates1/from-where-we-sit/streamlined-process-on-the-application-for-registration-of-computerized-accounting-systemcomputerized-books-of-accounts/), [KPMG Jul 2025](https://kpmg.com/ph/en/insights/2025/07/special-intax-july-2025-issue-1-volume-1.html) | V-S |
| X-11 | Withholding deadlines | eFPS staggered filing for 1601-C and 0619-E/F; 1601-EQ due the last day of the month after the quarter; 1604-C/F due around Jan 31 (the sources conflict on 1604-E: Mar 1); 2307 issuance timing conflicts between sources | [PwC 2026 tax calendar](https://www.pwc.com/ph/en/client-accounting-services/2026-tax-calendar/2026-february-tax-calendar.html), [JuanTax](https://help.juan.tax/en/articles/310-when-to-file-a-list-of-bir-tax-deadlines) | U |
| X-12 | eBIRForms offline package outage | A 2026-08 bank bulletin let AABs accept manual returns while the package was unavailable | [KPMG](https://kpmg.com/ph/en/insights/2026/08/special-intax-august-2026-issue-1-volume-4.html) | V-S (operational note) |

## 3. Form matrix by taxpayer profile

"Applies to" is **preliminary**; the accountant must confirm each row. A form version marked OPEN must be read from the official form or guide before its working paper is built.

| ID | Form | Purpose | Applies to (preliminary) | Current version found | Version status | Eligibility / applicability status | Supporting schedules / attachments (preliminary) |
|---|---|---|---|---|---|---|---|
| F-01 | 1701Q | Quarterly ITR, individuals | Sole proprietors and professionals | January 2018 (ENCS), per the eFPS form title | V-S | U | SAWT (if claiming creditable withholding tax) |
| F-02 | 1701 | Annual ITR, individuals (incl. mixed income) | Individuals with business income (and compensation) | 1701v2018 (S-06) | **V-P** | U | AFS / eAFS where required; SAWT |
| F-03 | 1701A | Annual ITR, individuals purely in business or profession | Graduated + OSD, or 8% | "1701A" (S-06; no year suffix given) | **V-P** (label only) | U | SAWT |
| F-04 | 1701-MS | Annual ITR, individuals classified Micro or Small | Micro / Small individuals | August 2024 | V-S | **U — relationship to 1701/1701A needs accountant confirmation** | Per guide (not yet read) |
| F-05 | 1702Q | Quarterly ITR, non-individuals | Corporations and partnerships | January 2018 (ENCS) (S-05) | **V-P** | U | SAWT |
| F-06 | 1702-RT | Annual ITR, regular rate | Corporations at the regular rate | 1702RTv2018C (S-06) | **V-P** | U | AFS via eAFS; SAWT; other schedules per the form |
| F-07 | 1702-EX | Annual ITR, exempt | Exempt corporations | 1702EXv2018C (S-06) | **V-P** | U | |
| F-08 | 1702-MX | Annual ITR, mixed rates | Corporations with mixed regimes | 1702MXv2018C (S-06) | **V-P** | U | |
| F-09 | 2550Q | Quarterly VAT return | VAT-registered | April 2024 (ENCS) (S-05); due the 25th day after quarter close (S-05) | **V-P** | Monthly 2550M status is U (X-02) | SLSP (X-08); SAWT for VAT withheld |
| F-10 | 2550M | Monthly VAT declaration | VAT-registered (optional?) | OPEN | OPEN | **U — conflicting sources** | |
| F-11 | 2551Q | Quarterly percentage tax | Non-VAT (not on 8%) | OPEN (ATCs referenced in S-05) | OPEN | U | SAWT |
| F-12 | 1601-C | Monthly remittance of compensation withholding tax | Employers | OPEN | OPEN | U | — |
| F-13 | 0619-E | Monthly remittance form, expanded withholding (first 2 months of a quarter) | Withholding agents | OPEN (bug fixes noted in S-05) | OPEN | U | — |
| F-14 | 0619-F | Monthly remittance form, final withholding | Withholding agents | OPEN | OPEN | U | — |
| F-15 | 1601-EQ | Quarterly expanded withholding return | Withholding agents | OPEN (new ATCs in S-05) | OPEN | U | **QAP** (S-07) |
| F-16 | 1601-FQ | Quarterly final withholding return | Withholding agents | OPEN | OPEN | U | QAP (S-07) |
| F-17 | 1604-C | Annual information return, compensation | Employers | OPEN | OPEN | U | Alphalist of employees (S-07) |
| F-18 | 1604-E | Annual information return, expanded withholding | Withholding agents | OPEN | OPEN | U | Annual alphalist of payees (S-07) |
| F-19 | 1604-F | Annual information return, final withholding | Withholding agents | OPEN | OPEN | U | Alphalist (S-07) |
| F-20 | 2307 | Certificate of creditable tax withheld at source | Issued by withholding agents | OPEN | OPEN | U | Supports the payee's SAWT |
| F-21 | 2316 | Certificate of compensation and tax withheld | Employers | OPEN | OPEN | U | Payroll module (later) |
| F-22 | 2306 | Certificate of final tax withheld | Withholding agents | OPEN | OPEN | U | |
| F-23 | 1600-VT / 1600-PT | VAT / PT withheld (government and other withholding agents) | Specific withholding agents | OPEN (in module scope per S-07) | OPEN | U | Monthly alphalist (S-07) |
| F-24 | 0605 | Payment form (advance PT payment per S-05) | Various | OPEN | OPEN | U | |
| F-25 | 1700 | Annual ITR, purely compensation | Not a business client form; usually out of scope | 1700v2018 (S-06) | V-P | Likely out of scope | |

## 4. Other compliance items

| ID | Item | Platform impact | Status |
|---|---|---|---|
| B-01 | Books of accounts type per client (manual / loose-leaf / CAS-CBA) and system registration | RMO 9-2021 lists systems that record sales and purchases or generate BIR reports as CAS/CBA "components" that the taxpayer-user registers (AC), with a joint sworn statement from any third-party provider. **D-02 is PENDING VERIFICATION; see doc 13.** | V-P text; applicability unconfirmed |
| B-02 | Loose-leaf book printouts (format, binding, submission); loose-leaf books registered within 15 days after year-end (S-13) | Report formats for FR-22 | Deadline V-P; format OPEN |
| B-03 | Record retention period | NFR-05 retention policy. **Conflict:** 5 years (RR 7-2024, V-S) vs. 10 years for TSP users (RMO 9-2021 §V.6 citing RR 5-2014, V-P citation) | **Accountant to confirm** |
| B-04 | Computerized books soft copy in **Standard Audit File (SAF)** format (RR 16-2006 / RR 9-2009), registered through ORUS annually within 30 days after year-end | New export requirement if D-02 means CBA | Requirement V-P; format OPEN |
| R-01 | Taxpayer classification (Micro/Small/Medium/Large) | Stored effective-dated; drives e-invoicing and form selection | V-S |
| R-02 | Invoice minimum information (RR 7-2024) | Field requirements for recorded sales | V-S; primary text to be read |
| R-03 | TIN and branch code format (9 + 3 or 9 + 5 digits) | Validation rules; DAT layouts | OPEN (read from the file-structure annexes) |
| R-04 | ATC master list and rates | `atc_codes` table; RMC 49-2025 shows ATCs change over time | Partial V-P (S-05 subset); full list OPEN |
| R-05 | Filing deadlines per form (incl. eFPS staggering by group) | Compliance calendar (M15) | U |
| R-06 | Penalties and interest | **Out of scope for computation in the MVP** (proposed) | — |

## 5. Items requiring accountant confirmation before any code is written

1. Every "Applies to" cell in §3, and the client profile dimensions in doc 01 §2.
2. Whether **1701-MS** replaces 1701 or 1701A for Micro and Small individuals, or is an alternative to them.
3. Current status of **2550M** (optional monthly VAT).
4. **Percentage tax rate** and any EOPT changes to the ₱3M VAT threshold.
5. Withholding **deadlines**, including 1604-E and 2307 issuance timing.
6. **Rounding** conventions on returns (centavos vs. whole pesos per form).
7. The full **ATC list** to be supported in the MVP.
8. Record **retention** period.
9. ~~Which returns are in MVP scope.~~ **The owner decided (D-03, 2026-10-10): all forms in §3 are in scope**, delivered in waves (doc 12 §5). The accountant must still confirm each form's applicability and supply golden cases before that form is activated.
