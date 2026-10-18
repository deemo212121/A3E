# Phase 14 Report: DAT Files, Alphalists and E-invoicing Compliance

**Date:** 2026-10-18
**Status:** Submitted for **accountant and compliance review**. **The SQL has NOT been applied yet** (§5).
**Gate:** *Hindi sapat ang successful export. Kailangang pumasa sa applicable validation at reconciliation.* (A successful export is not enough; it must pass the applicable validation and reconciliation.)
- **Enforced by the database:** a file reaches `validated` only when the official tool named in its specification, at that version, passed **for that exact file** (SHA-256 checked) **and** our own validation and reconciliation passed.
- No real output exists yet. The official specifications in doc 09 are all still **OPEN** (not obtained), so **no layout was implemented**, and none was invented.

## 1. What was built

| Requirement | Delivered |
|---|---|
| Each output a separate, versioned specification; DAT, schedules, alphalists, SLSP, QAP, SAWT distinguished | `output_specs` with `output_type`, version and effective dates |
| Record the authoritative spec and version | `spec_source` (citation, spec version, issue date) plus the official validator and version, required for approval |
| Field mapping, types, lengths, codes, ordering, encoding, file names, validation rules | A declarative layout transcribed from the spec ([tax/ELECTRONIC-OUTPUTS.md](tax/ELECTRONIC-OUTPUTS.md)); nothing silently truncated, transliterated or rounded |
| Deterministic generation and a validation report | Same rows give the same bytes regardless of input order (tested); every problem is reported by code, record, row and field |
| Reconcile totals and counts to approved transactions | Record counts; every summed amount against the source total (rounding differences fail); optional tie to a signed-off form workpaper line |
| Official BIR tool or documented procedure | Results recorded per file with the tool's log; a wrong tool or version, or a different file, is refused |
| Preserve the source snapshot and output version | Snapshot rows and their SHA-256, file content and SHA-256, specification version; files are never edited, only superseded |
| No invented layouts, no extension-based formats, no "valid" without validation | The registry ships empty; the generated status says "not validated" |
| E-invoicing: registrations, certifications, approvals, technical requirements, transmission verified separately; PDFs not presented as e-invoices | Evidence register: requirements verified against cited sources by a second reviewer; per-client assessments ("met" needs evidence). D-01: the platform issues no invoices. |

**Screens:**
- **Electronic outputs & e-invoicing** registry: specifications (fixtures, approve, enable) and the e-invoicing requirements register.
- Per client, on the **Tax** tab: generate files, and the e-invoicing assessments.
- A file page: validation report, reconciliation, snapshot and file hashes, download, official-result recording, sign-off.

## 2. Tests actually run (2026-10-18)

| Suite | Result |
|---|---|
| `npm run check` | **Pass: 31 files, 440 tests** |
| `tests/db/eoutputs.test.ts` | **7/7** with **synthetic TEST ONLY** layouts |
| Mutation checks | Each of these makes tests fail: dropping the "and our checks passed" rule, the exact-file hash check, the named-tool check, the encoding check, the rounding reconciliation, or the enabled-only rule |
| Cloudflare build | Builds. Worker 2,920 KiB compressed (free-plan limit 3,072 KiB) |
| **Live database tests** | **Not run.** They need the SQL applied first. |

**Boundary cases covered:**
- **Missing fields:** a missing customer TIN; a missing taxpayer TIN, which fails both the header and the file name.
- **Invalid codes and characters:** an invalid code; a non-ASCII letter (no transliteration); the delimiter inside a value.
- **Lengths and signs:** 21 versus exactly 20 characters; a fixed-width amount that's too wide; a negative amount.
- **Duplicates.**
- **Rounding:** to whole pesos, which breaks the total.
- **Determinism:** reversed input order gives the identical file.

**End-to-end:**
- **Generation:** an exact file from posted invoices, with the source snapshot and immutability.
- **Validation:** a wrong tool, a wrong file hash, and a failed result are all refused. A pass makes the file valid, and it is then signed off by a second person.
- **The gate:** an official pass with our own errors is still **not valid**.

## 3. Needed before any real output

For each output:
1. Obtain the spec annexes listed in doc 09 §4.
2. Transcribe the layout.
3. Build fixtures from the spec's own samples, plus boundary cases.
4. Accountant and compliance review.
5. Verify and enable.

For each client file, run the official module and record its output.

For e-invoicing, research and enter the requirements (doc 10), then verify each against its source.

## 4. Not built

- Direct eSubmission/eFPS transmission (none verified; replies are recorded by hand)
- Windows-1252 or other encodings
- EIS e-invoice JSON (D-01: the platform does not issue invoices)
- SAF books export

## 5. SQL to run (Supabase → SQL Editor), in order

After `0036`–`0039`:
1. `supabase/migrations/0040_eoutputs_core.sql`
2. `supabase/migrations/0041_eoutputs_functions.sql`
