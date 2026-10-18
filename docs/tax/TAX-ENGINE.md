# Tax Rules Registry and Computation Engine (Phase 12)

**Status:** framework implemented 2026-10-18.
- **No tax rules are implemented.**
- Nothing here computes a real tax until a rule passes the gate in §2.
- Computed figures are **working papers**, not filed returns, and are never called accurate or BIR-compliant until validated.

## 1. What the framework does

| Requirement | How |
|---|---|
| Versioned registry | `tax_rules`: code + version, tax type, effective dates, eligibility, declared inputs, parameters, formula, rounding policy, sources, status (draft → pending review → approved / rejected; retired). An approved version can never change: a new rate is a new version. Only one approved version per code may be in effect on any date. |
| Formulas | A safe JSON expression language (below). No SQL or code can be entered. It is checked when saved (unknown nodes, undeclared inputs, missing parameters, steps used before they are computed). |
| Rounding policy | Explicit `round` nodes inside formulas, plus the rule's output rounding (places and mode). Arithmetic is exact (numeric), never floating point. |
| Calculate only verified rules | `compute_tax` uses only an **approved** version in effect on the period end. Otherwise the result is **unsupported** (see §3). |
| Taxpayer profiles, configurable obligations | `tax_profiles` holds the facts used by eligibility; they are confirmed by a second person, and the approved business profile adds business type, VAT status and fiscal year end. `tax_obligations` says which rule codes apply to each client and from when. **Nothing is assumed.** |
| Adjustments apart from accounting profit | Ledger inputs come from **posted** entries through per-client account mappings. Adjustments and manual inputs are stored separately (`tax_adjustments`) with a reason and reference. **They never post to the books.** |
| Lineage | `tax_lineage` keeps every journal line behind each ledger input, with its entry and source document. The computation page links each one to the entry and the source. |
| Review | Every computation is prepared by one person and reviewed by a reviewer or manager who is a different person. Recomputing a period supersedes the earlier result. Nothing is deleted or edited. |

### Formula language

| Node | Meaning |
|---|---|
| `"12.5"` | number (exact decimal) |
| `{"input": "name"}` | a declared input |
| `{"param": "name"}` | a numeric parameter |
| `{"ref": "step"}` | an earlier step |
| `{"op": "add\|sub\|mul\|div\|min\|max\|neg", "args": [...]}` | arithmetic. Division by zero is an error. |
| `{"round": e, "places": 0–6, "mode": "half_away_from_zero\|down\|up"}` | rounding |
| `{"if": {"cmp": "gt\|gte\|lt\|lte\|eq\|neq", "args": [a, b]}, "then": e, "else": e}` | condition |
| `{"graduated": e, "table": "param"}` | graduated table `[{over, fixed, rate}]`: uses the last row whose `over` is below the value; result = fixed + (value − over) × rate. Values exactly on an edge use the lower row. |

- **Eligibility:** `[{fact, op: eq|neq|in|not_in|gte|lte, value}]`. All conditions must hold.
  - A **missing** fact means professional review.
  - A **failing** fact means not applicable.

## 2. The gate (enforced by the database)

A rule can be **approved** only if all of these hold:
1. It cites authoritative sources (citation and issue date).
2. It has at least one **normal** and one **boundary** fixture (worked expected results, with their basis).
3. **Every fixture was reviewed by an accountant other than its author** (firm accountant, reviewer or manager).
4. **Every fixture passes** when run through the engine.
5. The approver is a reviewer or manager **other than the rule's author**, and attests that they checked the rule against the cited official sources.
6. No other approved version of the code overlaps its dates.

**Regression:** `tax_regression(code)` reruns every fixture of every approved version with the version in effect on the fixture's date. The registry page shows it.

## 3. Outcomes

| Status | When |
|---|---|
| `computed` / `reviewed` | an approved rule, a confirmed profile, the client eligible, inputs mapped and entered |
| `unsupported` | **no verified and approved rule** covers the period; prepare it manually with professional review |
| `not_applicable` | not a configured obligation of the client, or the profile fails eligibility |
| `manual_review` | the profile is not confirmed, a needed fact is missing, an input is not mapped or not entered, or the rule changes inside the period |

Every attempt is recorded with its reason.

## 4. Implemented rules

**None.** Candidate computations come from doc 08 (BIR compliance research matrix) and the roadmap's tax waves. Each one needs, before entry:
- the official issuance(s) with dates
- worked expected results, including boundary cases, prepared and reviewed by the firm's accountants

## 5. Not built

- Return forms and DAT files (later phases)
- Filing
- Payment of taxes
- A compliance calendar UI
- Carry-forward between computations (enter it as a documented manual input)
