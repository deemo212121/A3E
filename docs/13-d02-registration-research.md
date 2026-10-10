# 13 — D-02 Research: BIR Registration Requirements for the Platform Design

> **D-02 status: PENDING VERIFICATION.** This document does **not** conclude that the platform is exempt from registration, and it does **not** claim BIR compliance. It sets out what the official issuances say, how they appear to apply to this specific design, and what the BIR, the Firm's accountant or qualified Philippine tax counsel must confirm.
> Research date: 2026-10-10. Status codes are as in the [README](README.md).

## 1. The design being assessed (as stated by the owner, 2026-10-10)

- Clients submit their **existing** invoices, receipts, sales, purchases, expenses and other records.
- The platform **extracts and organizes** the data, **prepares accounting entries and computations**, and **generates financial reports and applicable BIR forms**.
- Accountants **review and correct** the records before they are approved and posted.
- The platform **does not issue** official invoices to customers in the initial release. Invoices are issued outside the platform.

## 2. Official sources read for this analysis

| Ref | Issuance | Date / effectivity | Read | Status |
|---|---|---|---|---|
| S-10 | **RMO 9-2021**: Simplified guidelines and procedures on the use of CAS, CBA and/or their components, including ESS, middleware and similar systems | Dated 2021-02-01; "shall take effect immediately". The BIR digest gives the issue date as 2021-02-19. | Full text, 11 pp. — [link](https://bir-cdn.bir.gov.ph/local/pdf/RMO%20No.%209-2021.pdf) | **V-P** |
| S-11 | **RMC 5-2021**: Simplified policies on the application for registration of CAS, CBA and/or components | Dated 2020-12-28; received by BIR records 2021-01-08; "shall take effect immediately" | Full text, 3 pp. — [link](https://bir-cdn.bir.gov.ph/local/pdf/RMC%20No.%205-2021%20(1).pdf) | **V-P** |
| S-12 | **RR 7-2024**: EOPT implementation of Tax Code §§113, 235, 236, 237, 238, 242 and 243 (registration, preservation of books, invoicing) | Issued 2024-04-11 | BIR digest (table of contents only) — [link](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%207-2024%20(final).pdf) | V-P (outline only); body not read |
| S-13 | **RMC 91-2024**: Clarifies registration procedures under RR 7-2024 as amended by RR 11-2024 | Issued 2024-08-14 | BIR digest, 4 pp. — [link](https://bir-cdn.bir.gov.ph/BIR/pdf/RMC%20No.%2091-2024%20Digest.pdf) | **V-P** |
| S-14 | **RMC 4-2026**: Mandatory ORUS registration of loose-leaf and computerized books; deadline extension | Issued 2026-01-15 | BIR digest — [link](https://bir-cdn.bir.gov.ph/BIR/pdf/RMC%20No.%204-2026%20Digest.pdf) | **V-P** |
| S-03 | **RMC 98-2026**: E-invoicing guidelines | Issued 2026-09-22; effective immediately | Full text (see doc 10) | **V-P** |
| S-01 / S-02 | RR 11-2025 and RR 26-2025 | 2025-02-27 and 2025-10-16 | Digests (see doc 10) | **V-P** (digest) |

Secondary or not yet read:

| Ref | Item | Status |
|---|---|---|
| X-13 | RR 9-2009: bookkeeping requirements; CAS mandatory for Large Taxpayers (cited by S-10) | **OPEN.** Primary text not read. |
| X-14 | RR 16-2006: Standard Audit File (SAF) for computerized books (cited by S-10) | **OPEN** |
| X-15 | RMO 9-2021 **Annex B**: Standard Functional and Technical Requirements, which the system "shall strictly comply with" (S-10 §V.1) | **OPEN. Critical; must be obtained.** |
| X-16 | RMO 9-2021 Annexes A (checklist), C/C-1 (sworn statement and system description) and E (joint sworn statement with a TSP) | **OPEN** |
| X-17 | RMC 65-2025: book types available to new registrants; loose-leaf needs a PTU, CAS/CBA needs an AC | V-S ([Grant Thornton](https://www.grantthornton.com.ph/insights/articles-and-updates1/tax-notes/bir-clarifies-bookkeeping-options-for-new-business-registrants/)) |
| X-18 | RR 7-2024 retention: books kept **5 years** from the day after the filing deadline, extended while a protest or refund is pending. The older RR 17-2013 rule was 10 years. | V-S ([Grant Thornton](https://www.grantthornton.com.ph/insights/articles-and-updates1/tax-notes/eopt-is-here-updates-on-the-preservation-of-book-of-accounts-and-changes-in-taxpayer-registration/)) |
| X-19 | RR 14-2010 (amending RR 11-2006 and RR 4-2010): accreditation of tax practitioners or agents as a prerequisite to practice before the BIR | V-S ([SC e-Library](https://elibrary.judiciary.gov.ph/thebookshelf/showdocs/11/48243)); current amendments unknown |
| X-20 | BIR public advisory: as of 2026-09-14 no entity is accredited as an official e-invoicing service provider (ESP) | V-S (reported by [Aureada Law](https://www.aureadalaw.com/post/bir-electronic-invoicing-rules-under-rmc-no-98-2026-what-philippine-businesses-need-to-know-before)); advisory not read |

## 3. What the primary texts say (relevant extracts, paraphrased)

### 3.1 Definitions (RMO 9-2021 §III; RMC 98-2026 §II)
- **CAS:** integrated component systems that produce computer-generated books *and* accounting records, including **system-generated receipts and invoices**, covering the full cycle from the start of a transaction to the financial reports. "In any case that a receipt or invoice shall be **manually issued**, the system/software/application shall be considered as **Computerized Books of Accounts (CBA)** and Accounting Records." RMC 98-2026 restates this definition.
- **CBA:** a system that can generate books of accounts only, such as the general journal, general ledger, sales journal, purchase journal and inventory book.
- **Components of CAS or CBA:** any system adopted to generate accounting records, reports or documents, whether or not it is integrated with a CAS or CBA.
- **Electronic Storage System (ESS):** a system used by the taxpayer **or an accredited tax agent** for preserving books of accounts and other accounting records.
- **Cloud:** internet-based computing, considered "a hosted solution that client subscribes to".
- **Tax Service Provider (TSP):** a "third-party software provider … software/supplier/developer/professionals that provides services to users/organizations related to **taxes and bookkeeping** requirements".

### 3.2 Scope (RMO 9-2021 §IV)
1. **Large Taxpayers** mandated to use CAS under RR 9-2009.
2. **Non-large taxpayers** in business who **opted** to use a CAS, a CBA, or **components**. Components include:
   - (i) any system that generates the general journal and other subsidiary books;
   - (ii) any system used for **recording sales, purchases, AR, AP, inventory and payroll**;
   - (iii) any system that generates subsidiary ledgers and other accounting records (vouchers, journal vouchers, etc.);
   - (iv) any system that **generates reports required by the BIR, e.g. the Summary List of Sales and Purchases**;
   - (v) CRM/POS systems linked to a CAS or CBA.
3. Taxpayers using an ESS, middleware or similar systems.

### 3.3 Registration obligations (RMO 9-2021 §V; RMC 5-2021)
- The obligation is on the **taxpayer-user**. "All taxpayers who intend to use CAS, CBA and/or its Components … shall inform and register with the RDO/LT Office where it is registered." The system "shall strictly comply" with **Annex B**.
- An **Acknowledgement Certificate (AC)** is issued within 3 working days of a complete submission. There is no PTU, no demonstration and no pre-evaluation, but there **is post-evaluation**, and non-compliance can lead to revocation and penalties (RMO 7-2015).
- Third-party providers (§V.6): taxpayers using **TSPs or third-party software providers** "must register such system with the BIR **prior to the effectivity of their contract**". They execute a **Joint Sworn Statement (Annex E)** **signed by both the taxpayer and the TSP or provider**. Both must state that the system "has **no facility that may suppress sales/income**". Records must be kept for **10 years** (citing RR 5-2014) **at the principal place of business** and made available to the BIR. When the contract terminates, the taxpayer must notify the RDO, and termination **automatically cancels** the registration.
- **Affiliated companies** each register separately, even if they share servers and the same system (§V.4).
- Enhancements (§V.8–9):
  - A **major** enhancement requires a **new application for registration**. Examples: changed computations with financial effect; added or removed modules with financial impact; a version or release change with financial enhancements. Using an enhanced system without informing the BIR beforehand brings penalties.
  - A **minor** enhancement (UI, bug fixes, performance) requires written notice to the RDO.
- Books (§V "Books of Accounts"): books must follow the bookkeeping requirements of **RR 9-2009**. The soft copy of the CBA is registered annually within 30 days of year-end in **Standard Audit File (SAF)** format per RR 16-2006; **PDF is deemed unacceptable** as an SAF (§III.13).

### 3.4 Later registration mechanics (RMC 91-2024; RMC 4-2026)
- Books of accounts are registered through **ORUS**. **Computerized books are registered annually, within 30 days from the close of each taxable year.** Registration produces a **QR Code stamp**, which shows the **Acknowledgement Certificate Control No.** for computerized books. After ORUS registration, the transmittal letter and USB drive are no longer submitted at the RDO.
- RMC 4-2026 makes ORUS registration of loose-leaf and computerized books **mandatory**. For CY2025 books the deadline was extended to **2026-02-17**.

### 3.5 E-invoicing link (RMC 98-2026; RR 11-2025 as amended by RR 26-2025)
- Coverage item 4: "Taxpayers using **CAS or CBA with Accounting Records (with electronic invoicing)**, and other invoicing software."
- The PTI Electronic Invoice is **distinct from** the PTU or AC for CAS. An AC "authorizes the use of such systems but does not by itself constitute authority to issue electronic invoices" (§II.7).
- Systems without the capability to transmit to the buyer and the BIR produce **non-electronic** invoices (§IV.5).

## 4. Application to this design (analysis — **requires confirmation**)

| # | Question | What the texts suggest | Confidence | Confirm with |
|---|---|---|---|---|
| A-1 | Is the platform a **CAS**? | Under the definitions, a CAS includes system-generated invoices. Because invoices are issued outside the platform, the definition's own fallback suggests it would be treated as **CBA and Accounting Records**, not a full CAS. | Medium | Tax counsel / BIR |
| A-2 | Is it a **CBA or a "component"** within RMO 9-2021's scope? | **Likely yes** if a client's books or BIR reports are produced by it. It records sales, purchases and payables (§IV.2.c.ii), generates journals and ledgers (c.i), and generates BIR reports such as the SLSP (c.iv). These are expressly listed as components. | **High that it falls within the descriptions** | Tax counsel |
| A-3 | Does falling within scope **automatically** require registration for every client? | Scope ¶2 applies to non-large taxpayers "**who opted** to use" a CAS, CBA or components. Whether a client "uses" the system when the **Firm** operates it on the client's behalf (outsourced bookkeeping) is **not addressed expressly** in the text read. §V.6 (TSPs and third-party providers, defined to include bookkeeping service professionals) suggests the BIR expects registration with a joint sworn statement where a third party provides the system. | **Unresolved; do not assume an exemption** | Tax counsel; possibly a BIR ruling |
| A-4 | Could clients instead keep **manual or loose-leaf** books, with the platform as the Firm's internal working tool only? | Book types are manual, loose-leaf or computerized (X-17, V-S). Loose-leaf needs its own PTU and annual ORUS registration within 15 days after year-end (S-13). Whether a system that **produces** the loose-leaf printouts is itself a "component" requiring an AC is **not settled** by the texts read. | Low | Tax counsel |
| A-5 | Large Taxpayer clients | RMO 9-2021 scope ¶1: Large Taxpayers are **mandated** to use CAS under RR 9-2009. They will normally have their own registered CAS, and the platform would at most be a component or an external reporting tool. | Medium | Accountant / counsel |
| A-6 | Effect of **continuous software releases** | If registered, changes that alter computations, add or remove financial modules, or change the version with financial effect are **major enhancements needing new registration** (§V.8). This applies **per registered client**, which conflicts with frequent SaaS deployment. | High (the text is explicit) | Counsel, on how to scope "version" for a hosted system |
| A-7 | **Hosting location** (cloud) | RMO 9-2021 recognizes cloud systems by definition, but third-party arrangements must keep records "at their principal place of business" and available to the BIR (§V.6). Whether a cloud copy accessible from the principal place of business satisfies this is **not stated**. | Low | Counsel / BIR |
| A-8 | Is there a BIR **"accreditation" of CAS or CBA software vendors**? | No vendor-level accreditation of CAS/CBA software was found in RMO 9-2021. Registration is **by the taxpayer-user**, and the provider co-signs Annex E. (Vendor accreditation exists for **CRM/POS** suppliers under separate rules (§V.7), and e-invoicing service provider rules are pending.) | Medium | Counsel |
| A-9 | Does the platform trigger **e-invoicing** obligations? | The platform issues no invoices, so it is not "invoicing software". Coverage item 4 refers to CAS/CBA "**(with electronic invoicing)**". A CBA *without* invoicing does not appear to be the trigger on the face of the text, but this is **an interpretation, not a confirmation**. | Medium | Tax counsel |
| A-10 | Do clients' **own** e-invoicing obligations depend on the platform? | No. Each client may be covered for its own reasons: e-commerce classified Small, Medium or Large; under the LTS; Large under EOPT; or using another CAS, CBA or invoicing software or POS. Those clients must issue e-invoices from their own invoicing system by **2026-12-31** (S-02, S-03). | High (on the text) | Accountant, per client |

## 5. Requirements by party (preliminary — every row requires confirmation)

### 5.1 Platform operator (the entity that owns and runs the software)

| Requirement | Basis | Status |
|---|---|---|
| No vendor-level CAS/CBA accreditation identified | RMO 9-2021 (registration is by the taxpayer-user) | Interpretation; **confirm** |
| May need to **co-execute a Joint Sworn Statement (Annex E)** with each client, attesting to the system description and that there is **no sales or income suppression facility** | RMO 9-2021 §V.6 | V-P text; applicability **to confirm** |
| The system must meet **Annex B Standard Functional and Technical Requirements** | RMO 9-2021 §V.1; RMC 5-2021 ¶2 | **Annex B not obtained** |
| Classify every release as major or minor; support clients' re-registration or notice obligations | RMO 9-2021 §V.8–9 | V-P text |
| Produce computerized books in the **SAF** format required by RR 16-2006 / RR 9-2009 for annual ORUS registration | RMO 9-2021 §V "Books"; RMC 91-2024 | **Format spec OPEN** |
| If it ever issues e-invoices: PTI per client, EIS Certification, JSON per the EIS spec; ESP rules pending | RMC 98-2026 | Out of the initial scope (D-01) |
| If it ever files returns electronically for taxpayers: BIR certification as a Tax Software Provider for filing (a different "TSP" from RMO 9-2021's definition) | RMC 20-2026 Annex A lists certified TSPs | Out of scope; **confirm the process** if wanted later |
| Data Privacy Act obligations as personal information processor | RA 10173 | Legal (doc 07 §9) |

### 5.2 Accounting firm

| Requirement | Basis | Status |
|---|---|---|
| Accreditation of individual practitioners or the firm as **tax agents** to practice before the BIR (prepare, sign or represent) | RR 14-2010 amending RR 11-2006 / RR 4-2010 | V-S; **confirm the current rules and which staff need it** |
| If the Firm is also the platform operator, the §5.1 obligations apply to it as "TSP / third-party software provider" | RMO 9-2021 §III.14, §V.6 | Interpretation; confirm |
| If the Firm preserves client books on the platform, it may be operating an **ESS** ("used by … an accredited tax agent") | RMO 9-2021 §III.5, §IV.3 | Interpretation; confirm |
| Engagement terms must allocate responsibility for client registration, re-registration on major releases, and record availability to the BIR | Practical consequence of RMO 9-2021 §V.6 | Owner / legal |

### 5.3 Individual client businesses

| Requirement | Basis | Status |
|---|---|---|
| Choose and register a book type (manual, loose-leaf or computerized) | RR 7-2024; RMC 91-2024; RMC 65-2025 | V-P / V-S |
| **If** the platform is their CBA or component: register the system with their RDO or LT office **before** the contract with the provider takes effect (Annex A checklist, Annex C/C-1, **Joint Sworn Statement Annex E**), and obtain an **AC** | RMO 9-2021 §V.1, §V.6; RMC 5-2021 | V-P text; applicability **PENDING** |
| Register the computerized books annually through **ORUS** within 30 days after year-end, and keep the QR stamp | RMC 91-2024; RMC 4-2026 | V-P |
| Re-register on major enhancements; notify the RDO of minor ones; notify the RDO **before** the provider contract ends (termination cancels the registration) | RMO 9-2021 §V.6, §V.8–9 | V-P |
| Preserve books and records for the required period at the principal place of business, available to the BIR | RR 7-2024 (5 years, V-S); RMO 9-2021 §V.6 (10 years citing RR 5-2014) | **Conflict; accountant to confirm** |
| Large Taxpayers: maintain their own CAS (RR 9-2009) | RMO 9-2021 §IV.1 | V-P (citation); RR 9-2009 not read |
| Own **e-invoicing** obligation by **2026-12-31** if covered (e-commerce S/M/L, LTS, Large, CAS/CBA with e-invoicing, other invoicing software): PTI before issuance, EIS Certification within 6 months; micro taxpayers exempt | RR 11-2025 as amended by RR 26-2025; RMC 98-2026 | V-P |

## 6. Architectural consequences (adopted as design constraints while D-02 is pending)

These keep both outcomes of D-02 possible: registration needed, or not needed.

1. **Assume registration may be required.** Build to RMO 9-2021 Annex B once it is obtained, and treat Annex B as a requirements input for Phases 4–6.
2. **No sales or income suppression capability:** no hard deletes of posted data, no hidden adjustments, a complete audit trail. This is already a design invariant (docs 05 and 07) and supports the Annex E attestation.
3. **Release management:** version the software (semantic version plus a "financial-impact" flag on each release). Keep a release register showing which changes are *major* in the RMO 9-2021 sense. Be able to pin a client to an approved version until it re-registers, which requires a per-client feature/version gate. **Needs counsel input on what "version" means for a hosted system.**
4. **SAF export** of the books, once the RR 16-2006 / RR 9-2009 format is obtained (new item in the doc 09 register).
5. **Client registration tracking:** book type, AC control number (ACCN) and date, ORUS QR registration per year, PTI and EIS status, and the provider-contract dates (for the termination-notice obligation).
6. **Record preservation:** retention by the stricter of the confirmed periods. Export or hand-back on contract termination so the client can keep records at its principal place of business.
7. **E-invoice ingestion, not issuance:** accept clients' externally issued e-invoice data, ideally the BIR JSON once the EIS spec is obtained. Do not issue invoices (D-01).
8. **Do not market the platform as "BIR-registered", "BIR-accredited" or "BIR-compliant"** until D-02 is resolved, and then only as precisely as the confirmed status allows.

## 7. Questions to put to tax counsel and/or the BIR (proposed wording)

1. When an accounting firm uses its own hosted software to record a client's transactions and produce the client's journals, ledgers, financial statements and BIR reports (with invoices issued manually or by other systems), must **the client** register that software as a CBA or component under RMO 9-2021, with a Joint Sworn Statement by the firm or software provider?
2. If the client keeps manual or loose-leaf books, and the firm's software is used only to *prepare* the entries and printouts, is the software still a "component" requiring an AC?
3. For a hosted multi-client system updated centrally, what is a "change in the system/software Version or Release Number" for the major-enhancement rule? Must every registered client re-register on each financial-impact release?
4. Does "CAS or CBA with Accounting Records (with electronic invoicing)" in RR 11-2025 §3(A)(4) and RMC 98-2026 §III.4 cover a CBA that does **not** issue invoices?
5. Which retention period applies to computerized records: 5 years (RR 7-2024) or 10 years (RR 5-2014 as cited in RMO 9-2021 §V.6)? Is cloud storage abroad acceptable if the records are accessible at the principal place of business?
6. Which Firm personnel must hold current BIR tax agent accreditation for the services planned?

## 8. Documents to obtain

- RMO 9-2021 **Annexes A, B, C, C-1, D and E**. The copy read has 11 pages with the annexes referenced but not included.
- Full texts of **RR 9-2009**, **RR 16-2006** (SAF), **RR 7-2024**, **RR 11-2024**, **RR 5-2014** and **RMC 65-2025**.
- The current tax agent accreditation regulations, from RR 14-2010 onward.
- The BIR advisory on e-invoicing service providers (2026-09-14) and the forthcoming ESP and PTI issuances.
