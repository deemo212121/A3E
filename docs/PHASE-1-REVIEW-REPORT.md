# Phase 1 Review Report — Requirements, Research, and Architecture

**Revision 2 — 2026-10-10.** Revision 1 was submitted on the same date. This revision adds the owner's decisions and the D-02 registration research.
**Status:** Submitted for review. **Phase 2 will not start without explicit approval of this updated documentation.**

## 1. Scope delivered

| Required deliverable | Location |
|---|---|
| Project overview and business requirements | [01](01-project-overview-and-requirements.md) |
| User roles and permissions matrix | [02](02-roles-and-permissions.md) |
| Client-to-accountant workflows | [03](03-client-accountant-workflows.md) |
| Complete module dependency map | [04](04-module-dependency-map.md) |
| Accounting transaction lifecycle | [05](05-accounting-transaction-lifecycle.md) |
| Proposed PostgreSQL ERD | [06](06-database-erd.md) |
| Supabase security and tenant-isolation design | [07](07-security-and-tenant-isolation.md) |
| BIR compliance research matrix | [08](08-bir-compliance-research-matrix.md) |
| DAT/alphalist file specification register | [09](09-dat-file-specification-register.md) |
| Electronic invoicing research | [10](10-electronic-invoicing-research.md) |
| Deployment architecture and preliminary costs | [11](11-deployment-architecture-and-costs.md) |
| Risks, assumptions, open questions, roadmap, **decision register** | [12](12-risks-assumptions-questions-roadmap.md) |
| **D-02 registration research (new in rev. 2)** | [13](13-d02-registration-research.md) |

## 2. Changes in revision 2

| Area | Change |
|---|---|
| D-01 | **APPROVED:** the platform does not issue invoices in the initial release |
| D-02 | **PENDING VERIFICATION.** New doc 13 researches CAS/CBA/component registration for the stated design and separates the obligations of the platform operator, the accounting firm and client businesses. No exemption is assumed and no compliance is claimed. |
| D-03 | **APPROVED: all forms in scope.** The roadmap's tax phase is split into waves A, B and C (doc 12 §5). |
| D-04 | **DEFERRED:** the owner will host on Cloudflare later. Planning notes added (doc 11 §2a). Database region and RA 10173 clearance remain open. |
| D-12 / D-15 | **DEFERRED:** Docker / local database and Git remote, to be provided by the owner |
| New items | D-16 (release management), R-15 to R-17, Q-17, B-04 (SAF export), DAT register item D-13 (SAF) |
| Docs 08 / 09 / 10 | Added the new primary sources S-10 to S-14, the retention conflict, the SAF requirement, and the e-invoicing effects on the approved design |

## 3. Repository inspection

- At the start of Phase 1 the workspace was **empty**: no code, no docs, no Git repository.
- Tooling: Node v24.19.0, npm 11.17.0, Git 2.55.0. Docker and the Supabase CLI are **not installed** (D-12 deferred).

## 4. Changed files

All under `docs/`, documentation only:
- Revision 1 (new): `README.md`, `01-…` through `12-…`, `PHASE-1-REVIEW-REPORT.md`.
- Revision 2: **new** `13-d02-registration-research.md`; **updated** `README.md`, `08-…`, `09-…`, `10-…`, `11-…`, `12-…`, `PHASE-1-REVIEW-REPORT.md`.

**No application code, migrations, database tables, packages, or configuration were created.** Git is not initialized (D-15 deferred).

## 5. Checks actually executed

| Check | Result |
|---|---|
| Relative links resolve; code fences balanced; table rows have consistent column counts | **Passed** (re-run after revision 2): 15 files, 31 links, 0 issues |
| Mermaid diagrams render | **Not executed.** No renderer is installed. Check visually in the VS Code Markdown preview or on GitHub. |
| Automated tests | **None.** There is no code in Phase 1. |
| BIR validation, migrations, security scans, deployment | **Not applicable / not executed.** Nothing claims these. |

## 6. Research summary

- **Primary BIR documents read (V-P):** RR 11-2025 and RR 26-2025 digests; RMC 98-2026 full text; the BIR press release of 2026-09-23; RMC 49-2025, RMC 20-2026, RMC 7-2021, RMC 61-2024 and RMC 15-2025 digests. **Added in rev. 2:** RMO 9-2021 full text; RMC 5-2021 full text; RMC 91-2024 and RMC 4-2026 digests; RR 7-2024 digest outline.
- **D-02 key findings (doc 13). Every applicability point still needs counsel or BIR confirmation.**
  - RMO 9-2021 expressly includes, as CAS/CBA "components", any system used for **recording sales and purchases** and any system that **generates BIR reports such as the SLSP**. The platform design matches these descriptions.
  - Registration is done **by each taxpayer-user** with its RDO, which issues an Acknowledgement Certificate. A third-party or "Tax Service Provider" system needs a **Joint Sworn Statement** signed by both the client and the provider, including a **no sales or income suppression** attestation.
  - A **major enhancement** (a change in financial computations or modules, or a version change with financial effect) requires **re-registration**. This matters greatly for a centrally updated SaaS product (R-15).
  - Because invoices are issued outside the platform, the definitions treat such a system as "CBA and Accounting Records" rather than a full CAS.
  - Computerized books are registered **annually through ORUS within 30 days after year-end**, in **SAF** format, not PDF.
  - No vendor-level CAS/CBA software accreditation was found. The registration obligation rests on the taxpayer-user.
- **E-invoicing effect:** the platform issues no invoices, so the **2026-12-31** deadline attaches to **covered clients'** own invoicing systems, not to the platform's functions. Whether a CBA *without* e-invoicing falls under coverage item 4 is an interpretation for **tax counsel** to confirm.
- **Conflicts:** record retention of 5 years (RR 7-2024, V-S) vs. 10 years (RMO 9-2021 citing RR 5-2014). Plus the conflicts from revision 1: 2550M, the percentage tax rate, 1701-MS vs. 1701/1701A, and withholding deadlines.
- **Not obtained:** RMO 9-2021 **Annexes A–E (including Annex B, the technical standards)**; RR 9-2009; RR 16-2006 (SAF); the full RR 7-2024; the DAT field-level specs; the EIS JSON schema.

## 7. Unresolved risks (top 6)

1. **R-06 / D-02:** client registration of the platform as a CBA or component may be required. Status pending.
2. **R-15:** if registration applies, each financial-impact release could need per-client re-registration.
3. **R-03:** official DAT and SAF file structures are not obtained.
4. **R-01 / R-14:** many tax items are only secondary or unverified, and no encoding happens without sign-off.
5. **R-09:** RA 10173 clearance for the hosting location is not yet given.
6. **R-11:** no local database environment yet (D-12 deferred), which blocks Phase 2 testing.

## 8. Decision register summary (full register: doc 12 §4)

| ID | Decision | Status |
|---|---|---|
| D-01 | No client invoice issuance in the initial release | **APPROVED** |
| D-02 | CAS / CBA / component registration | **PENDING VERIFICATION** (doc 13; counsel or BIR questions in §7) |
| D-03 | All forms in scope, delivered in waves | **APPROVED** |
| D-04 | Hosting on Cloudflare; DB region and privacy clearance open | **DEFERRED** |
| D-05 to D-11 | Workstation, sign-off policy, client approval, corrections, admin access, numbering, client MFA | PROPOSED: awaiting owner or accountant |
| D-12 | Local database (Docker) | **DEFERRED** |
| D-13 | Payroll and inventory timing | PROPOSED |
| D-14 | Budget, to be re-estimated for Cloudflare | PROPOSED |
| D-15 | Git remote | **DEFERRED** |
| D-16 | Release management for financial-impact changes | PROPOSED (depends on D-02) |

**Approval needed from the owner:** D-05, D-07, D-09, D-11, D-13, D-14, D-16, and Q-17 (whether the platform operator is the same entity as the accounting firm).
**Approval needed from the accountant:** D-06, D-08, D-10; doc 08 §5 items 1–8; Q-01 to Q-11; the retention-period conflict.
**Confirmation needed from tax counsel or the BIR:** doc 13 §7 questions 1–6 (resolves D-02 and the e-invoicing coverage interpretation).

## 9. Manual actions required

1. Send the **accountant's preliminary form list** (Q-01).
2. Name the accountant signatories (Q-03).
3. **Engage tax counsel** with doc 13 §7, or request BIR confirmation.
4. Obtain **RMO 9-2021 Annexes A–E**, RR 9-2009 and RR 16-2006 (SAF), the RMC 15-2025 Annexes A and B, and the RELIEF module/spec.
5. Obtain legal input on RA 10173 hosting and NPC requirements (Q-13).
6. When ready: Docker or a dev database (D-12), the Git remote (D-15), and the Cloudflare and database hosting details (D-04).

## 10. Acceptance criteria for Phase 1 (revision 2)

- [ ] All 13 deliverables have been reviewed by the owner.
- [ ] The decision register (doc 12 §4) reflects the owner's decisions correctly: D-01 approved, D-02 pending verification, D-03 approved, D-04/D-12/D-15 deferred.
- [ ] The owner accepts the **interim design constraints** in doc 13 §6 while D-02 is pending.
- [ ] The accountant has reviewed doc 08 and marked each form row *confirm / correct / out of scope*. This may proceed in parallel; it is **required before Phase 8**, not before Phase 2.
- [ ] The roles matrix (doc 02), the workflows (doc 03), the ERD (doc 06) and the lifecycle invariants (doc 05) are accepted or corrected.
- [ ] The roadmap (doc 12 §5) is accepted, including the wave split and the scope of Phase 2.
- [ ] It is acknowledged that **no BIR registration status, exemption or compliance is claimed**.
- [ ] Before Phase 2 *execution* (not approval): D-12 (local database) and D-15 (Git) are in place.
