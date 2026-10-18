# Recurring Maintenance Checklist: BIR and Regulatory Updates

**Owner:** the firm's accountant (compliance). **Support:** the technical admin.
**Frequency:**
- **Weekly** scan (§1)
- **Monthly** review meeting (§2)
- **Immediately** when an issuance affects anything in the platform (§3)

**Principle:** an update is applied as a **new version** with an effective date, through the approval gates. Nothing historical is recalculated silently (handbook §5).

## 1. Weekly scan (15–30 minutes)

| Done | Source to check | What to look for |
|---|---|---|
| ☐ | BIR website: Revenue Regulations (RR), Revenue Memorandum Circulars (RMC), Revenue Memorandum Orders (RMO), advisories | New or amended rules on rates, thresholds, forms, deadlines, withholding (ATCs), VAT, percentage tax, income tax |
| ☐ | BIR forms page (BIR Forms / eBIRForms downloads) | New form versions (e.g. "January 2018 ENCS" → newer), retired forms |
| ☐ | eBIRForms and eFPS advisories; Alphalist Data Entry & Validation Module releases | New validation module versions; DAT layout changes; file-name rules |
| ☐ | eSubmission / eAFS advisories | Submission channel changes; file requirements |
| ☐ | E-invoicing (EIS) issuances and advisories, e.g. follow-ups to RMC 98-2026 | Registration, certification, technical or transmission requirements; ESP accreditation |
| ☐ | Filing-deadline advisories (extensions, holidays, system downtime) | Due-date changes for the calendar |
| ☐ | SSS, PhilHealth, Pag-IBIG circulars (if payroll is used) | Contribution tables, ceilings, effective dates |
| ☐ | NPC circulars and advisories | Data privacy duties (breach, registration, security) |

Record every relevant item in the **Update log** (§4), even when the impact is "none".

## 2. Monthly review (with a reviewer or manager)

For each logged item, assess the impact on each area:

| Area | Question | If yes |
|---|---|---|
| **Tax calculations** (rules) | Does it change a rate, threshold, base, rounding or eligibility for any **approved** rule, or require a new rule? | New rule version (handbook §5) |
| **BIR forms** | New form version, new or changed lines, new schedules or validations? | New form version, then enable after sign-off |
| **Alphalists / DAT exports** | New layout, field length, code list, encoding, file name or validation module version? | New specification version (handbook §6) |
| **Withholding codes (ATCs)** | New or changed ATC or rate? | Propose and sign off the withholding code change |
| **Deadlines** | New or moved due dates, or extensions? | New deadline-rule version, or an approved due-date exception per filing |
| **E-invoicing** | New requirement, deadline, certification or accreditation? | Add or update a register requirement; second-person verification; reassess each client |
| **Payroll tables** | New contribution or withholding table? | New statutory rule set with sign-off |
| **Data privacy** | New NPC duty? | DPO updates the procedures |
| **Platform registration (D-02)** | Anything on CAS/CBA registration or acknowledgement? | Update doc 13; escalate to counsel |

For every "yes", open a **work item** (kind *review*) on the firm's own tracking client, or in the change log, with an owner and a due date before the effective date.

## 3. Applying a change (every time)

1. ☐ **Read the primary text**, not only a digest. Record the issuance number, date, effective date and URL. Mark V-P only after reading the primary text.
2. ☐ **Decide the effective date** and the affected periods. The old version stays in force for earlier periods.
3. ☐ **Propose the new version** in the registry, with its source.
4. ☐ **Fixtures:**
   - normal and boundary cases **from the issuance's own examples**
   - plus the old version's fixtures, which must still pass for old dates
5. ☐ **Second-person review** of the fixtures, then **approval** by someone other than the author.
6. ☐ **Regression** (handbook §7) passes for all versions.
7. ☐ **Enable** (forms and files): manager sign-off statement plus evidence location.
8. ☐ **End the previous version** the day before the new effective date. The system refuses if work after that date already used it; resolve those first.
9. ☐ **Recalculation review:**
   - list computations, workpapers, files and filings for periods **on or after** the effective date that were prepared before the change
   - for each, decide to recompute (new result supersedes; reviewed by a second person) or to leave it, with the reason
   - **filed returns are never changed;** decide whether an amended return is needed
10. ☐ **Tell the team** (work queue or meeting), and the affected clients if their filings change.
11. ☐ **Log** it in the update log with the outcome and approvers.

## 4. Update log (keep in the firm's records; one row per issuance)

| Date seen | Issuance (number, date) | Status (V-P/V-S) | Effective | Areas affected | Decision | New version(s) | Regression | Approved by | Recalculation decisions |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

## 5. Quarterly

- ☐ Re-read the OPEN and V-S items in docs 08, 09, 10 and 13. Promote them to V-P when the primary text is read, or keep them flagged.
- ☐ Check that every **enabled** form or specification still matches the current official version and validation module.
- ☐ Run the readiness SQL: its REVIEW rows list every approved or enabled tax item. Confirm each still has its evidence.
