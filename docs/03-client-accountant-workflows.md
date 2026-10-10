# 03 — Client-to-Accountant Workflows

Each workflow lists its actors, steps, system states and controls. Status names are proposed and will become database enums.

---

## W1. Client onboarding

**Actors:** firm_manager, accountant, client_owner

```mermaid
flowchart LR
  A[Manager creates client record] --> B[Assign preparer + reviewer]
  B --> C[Invite client_owner via email]
  C --> D[Client accepts invite, sets password + MFA]
  D --> E[Client uploads COR 2303, SEC/DTI docs, prior FS/returns]
  E --> F[Accountant drafts taxpayer profile + tax registrations]
  F --> G[Reviewer approves profile]
  G --> H[System generates compliance calendar from approved profile + active rule sets]
  H --> I[Opening balances entered as a posted opening entry]
```

**Controls**
- The taxpayer profile stays in `draft` until a reviewer approves it. Compliance calendars are generated only from approved profiles.
- The TIN format is checked: 9 digits plus a branch code. The format is to be confirmed (doc 08 item R-03).
- Opening balances are posted as one balanced journal entry of type `opening`, linked to supporting documents.
- The engagement letter, consent and privacy notice are recorded with timestamps (RA 10173; text needs legal review).

---

## W2. Monthly document submission

**Actors:** client_user, client_owner, bookkeeper

```mermaid
stateDiagram-v2
  [*] --> uploaded
  uploaded --> in_review: staff picks up
  in_review --> needs_info: issue found
  needs_info --> uploaded: client re-uploads/answers
  in_review --> processed: transactions recorded & linked
  in_review --> rejected: not a valid document
  processed --> [*]
```

**Controls**
- Files go to the private bucket under `clients/{client_id}/...`. Allowed MIME types are on an allowlist, and size is capped (proposed: 25 MB).
- A SHA-256 hash is computed on upload, and duplicate hashes within the same client are flagged.
- A document linked to a posted entry cannot be deleted.
- Each document carries a category (sales invoice, purchase invoice, 2307 received, bank statement, payroll, other), a period and an optional counterparty.

---

## W3. Information request (Request for Information, RFI)

1. A staff member creates a request with a due date, linked to a client, a period and optionally an entry or document.
2. The client is notified by email and in the portal.
3. The client answers in text, by upload, or both.
4. Staff resolve or reopen the request.

States: `open → answered → resolved` or `open → cancelled`. Overdue requests show on the dashboard.

---

## W4. Bookkeeping, review and posting

See doc 05 for the full journal entry lifecycle.

```mermaid
sequenceDiagram
  participant B as Bookkeeper/Accountant
  participant S as Server (Next.js)
  participant DB as Postgres (RLS + functions)
  participant R as Reviewer
  B->>S: Create draft entry (lines, source doc links, idempotency key)
  S->>DB: insert draft (RLS: assigned client)
  B->>S: Submit for review
  S->>DB: fn_submit_entry() — checks balance, period open, required fields
  R->>S: Approve
  S->>DB: fn_approve_and_post() — SoD check, balance check, period check, assigns entry number, status=posted
  DB-->>S: posted entry no.
  Note over DB: Posted entries immutable (trigger). Corrections = fn_reverse_entry()
```

---

## W5. Period close

1. The preparer finishes the checklist: all documents processed, no open requests that block close, bank reconciled (when that module exists), and the trial balance reviewed.
2. A reviewer **soft-closes** the period. Only adjusting entries approved by a reviewer can then be posted.
3. A manager **locks** the period. No posting at all is allowed after that.
4. Reopening needs a manager, a reason and an audit event, and alerts the assigned reviewer.

---

## W6. Tax return preparation and filing

```mermaid
stateDiagram-v2
  [*] --> draft: system computes from locked/soft-closed period + active rule set
  draft --> prepared: preparer adjusts/annotates
  prepared --> reviewed: reviewer approves (SoD)
  reviewed --> client_approved: client_owner approves
  client_approved --> filed: staff records filing proof (eFPS/eBIRForms confirmation)
  filed --> paid: payment proof recorded (or n/a for no-payment returns)
  filed --> amended: amended return created (new version, links original)
  prepared --> draft: reviewer returns with comments
```

**Controls**
- A return records the rule-set version, the form code, the **form version** (for example `2550Q April 2024 (ENCS)`) and the source ledger snapshot it used, which is a hash of the underlying journal lines.
- If the ledger changes after a return is `reviewed`, the return is flagged `stale`.
- **The platform does not submit returns to the BIR.** Staff file through eFPS, the eBIRForms offline package or another BIR-sanctioned channel, then upload the confirmation. A manual step in the client's chosen filing channel is required. Whether the Firm uses the eBIRForms offline package or eFPS for each client is per-client data.
- Whether a client must approve each return before filing (proposed) or approval can be waived is decision D-07.

---

## W7. DAT file generation and validation (QAP, SAWT, SLSP, alphalists)

```mermaid
flowchart LR
  A[Select client + period + file type] --> B[Generator builds file per registered spec version]
  B --> C[Internal pre-validation: TINs, ATCs, totals vs ledger/return]
  C -->|errors| A
  C -->|pass| D[Reviewer approves file]
  D --> E[Staff runs OFFICIAL BIR module outside the platform]
  E --> F[Upload official validation output/log + any BIR eSubmission reply]
  F --> G[Status: officially_validated / rejected]
```

- Internal pre-validation is labelled **"Pre-check (not BIR validation)"** everywhere in the UI.
- If the official BIR validation module is a Windows desktop application, as historically, it runs outside the platform. Whether staff run it on a Firm workstation is part of decision D-05.

---

## W8. Withholding certificates (2307 / 2316)

- 2307 data issued by a client comes from purchase or disbursement transactions that carry an ATC. The printable format must match the current official form version, which is **OPEN** (doc 08).
- 2307s a client receives are uploaded in W2 and recorded as creditable tax withheld. They feed the SAWT.

---

## W9. Correction workflows

| Situation | Mechanism |
|---|---|
| Error in a posted entry, period still open | Reversal entry plus a corrected entry, linked as `reverses` / `corrects` |
| Error found after the period is locked | An adjusting entry in the current open period, or a manager reopens the period (SoD-4). Accountant policy is decision D-08. |
| Error in a filed return | An amended return version, linked to the original. The original stays immutable. |
| Wrong document upload | Soft-delete only if the document is unlinked. Otherwise unlink it through a reversal first. |
