# Electronic Tax Outputs and E-invoicing Compliance (Phase 14)

**Status:** framework implemented 2026-10-18. **No output layout is implemented.**
- None of the official technical specifications in doc 09 (QAP, alphalists, SAWT, SLSP, SAF, EIS JSON) has been obtained. Every row there is still **OPEN**.
- No layout is invented, and no format is inferred from a file extension.
- **A successful export is not enough:** a file is valid only after the applicable official validation **and** our validation and reconciliation have passed.

## 1. One versioned specification per output

Each output (DAT export, supporting schedule, alphalist, SLSP, QAP, SAWT, other) is its own `output_specs` row, with:

| Requirement | Field |
|---|---|
| Authoritative technical specification and version | `spec_source` (citation, `spec_version`, `issued_on`, url) |
| Official validator | `official_tool` + `official_tool_version` (the BIR module or documented procedure); **required** before approval |
| Field mapping, data types, lengths, allowed codes | `layout.records[].fields[]`: source, type (text/number/date), length, decimals, date format, `allowed` codes, `pattern`, upper-case, digits only, slice, padding, unsigned |
| Ordering | `layout.order_by` (then a deterministic tie-break) |
| Encoding | `layout.encoding` (`ascii` or `utf8`). Characters outside the encoding are **errors**, never silently transliterated. |
| Record separation | `layout.format` (delimited or fixed width), delimiter, quoting, `line_end` (CRLF/LF), final newline |
| File-name rules | `layout.filename` template plus `filename_pattern` |
| Grouping | `group_by` plus `sums` (e.g. per payee and ATC), exact numeric sums |
| Validation rules | the field rules, `unique_keys` (duplicates), required values |
| Source data | `dataset`: posted transactions only (purchase-bill withholding lines, sales invoices, purchase-bill lines, receipts with withholding), each row carrying its source id |

## 2. Gates

1. **Approve** (verified against the official spec) requires:
   - the citation, spec version and issue date
   - the official tool and version
   - a normal and a boundary fixture with the **exact expected file**, each reviewed by an accountant other than its author, all passing
   - a reviewer or manager other than the author, who attests a field-by-field comparison
2. **Enable** (production): a firm manager other than the author records the accountant/compliance sign-off and where the evidence is kept.

## 3. Generation and validity

`generate_output(client, code, period)`:
- **Preconditions:** the output must be a configured obligation of the client, with an **enabled** specification covering the whole period.
- **Steps:**
  - takes a **snapshot** of the source rows (kept with its SHA-256)
  - filters and aggregates
  - orders deterministically
  - formats every field
  - builds the file name and the file (kept with its SHA-256)
- **Validation report:** each problem by code (REQUIRED, INVALID_CODE, INVALID_FORMAT, INVALID_CHAR, TOO_LONG, NEGATIVE, NOT_A_NUMBER, NOT_A_DATE, DUPLICATE, FILENAME, ROUNDING), with record, row and field.
- **Reconciliation:**
  - record counts
  - every summed amount in the file against the source total (any rounding difference fails)
  - optionally, a signed-off form workpaper line
- **Status flow:**

| Status | Meaning |
|---|---|
| `generated` | Produced. **Not valid.** |
| `validation_failed` | The official tool failed, **or** it passed but our validation or reconciliation failed, or eSubmission rejected the file |
| `validated` | The official tool named in the spec, at that version, passed **for this exact file** (SHA-256 checked) **and** our checks passed. The log is kept. |
| `signed_off` | Validated, then signed off by an accountant other than the generator |
| `superseded` | Replaced by a newer generation; nothing is ever edited |

## 4. E-invoicing compliance

- **The platform does not issue invoices (D-01).** Invoices are recorded from the client's own documents. A record or PDF here is never presented as an electronic invoice.
- **The register** (`einvoice_requirements`) holds each registration, certification, approval, technical requirement and transmission mechanism, with its official sources. A second reviewer verifies each one.
- **Client assessments:**
  - "met" needs evidence, and "not applicable" needs the reason
  - only reviewers or managers can assess
  - the history is append-only
- The register ships **empty**. Doc 10 lists what to research (e.g. RMC 98-2026, the EIS certification portal; V-P).

## 5. To enable a real output

1. Obtain the issuance's file-structure annex and naming convention (doc 09 §4).
2. Transcribe the layout.
3. Build fixtures from the specification's own samples, plus boundary cases.
4. Get accountant review.
5. Verify and enable.

For each client file: generate, run the official module on the downloaded file, paste the module's output as the validation log, then sign off.
