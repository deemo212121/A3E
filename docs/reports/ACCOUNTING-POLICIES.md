# Financial Reporting: Accounting Policies and Assumptions (Phase 11)

**Status:** implemented 2026-10-18. **PROPOSED: PENDING CPA REVIEW.**
- The layouts below follow common practice for Philippine SMEs. They are **not** confirmed to meet PFRS for SMEs or PFRS for Small Entities, and no compliance is claimed.
- ❓ The CPA should confirm which framework applies to each client.

## 1. Source of the figures

- **Only posted journal entries** count (status posted or reversed).
  - Drafts and submitted entries never appear.
  - A reversal posts an equal and opposite entry, so the pair nets to zero in every report.
- Every statement is built from one database read model, `report_account_balances`, which gives each account's balance before the period, its debits and credits in the period, and its balance at the end. The screens, the client portal and the CSV export all use the same builder.
- **Basis:** accrual, as recorded by the modules (sales, purchases, inventory, payroll) and manual entries.
- **Accounting profit is not taxable income.** No tax liability is derived from these reports. Tax computations belong to the tax phases and need CPA validation.

## 2. Statements

| Report | Period | Notes |
|---|---|---|
| Trial balance | From–to | Opening balance (Dr − Cr), period debits and credits, and closing balance per account. Check: debits = credits, and opening/closing balances net to zero. |
| Income statement | From–to | Revenue − cost of sales = gross profit; − operating expenses = operating profit; ± other income/expenses = profit before tax; − income tax **as recorded** = net profit. **Year-end closing entries are excluded**, so a closed year still shows its result. |
| Balance sheet | As of | Current and non-current assets and liabilities, and equity. Profit not yet closed into retained earnings is shown in equity: "Profit of prior years not yet closed" and "Profit for the current year to date" (from the fiscal-year start). Check: assets = liabilities + equity. |
| Cash flow | From–to | **Indirect method:** profit + non-cash items + changes in working capital = operating; investing; financing. Check: opening cash + net change = closing cash. Closing entries are excluded. |
| AR / AP aging | As of | From the Phase 7/8 subledgers |
| Reconciliation summary | As of | Trial balance check, plus AR, AP, inventory and payroll subledgers against the ledger. Payroll lines appear only for users with payroll access. |

## 3. Classification (default mapping, override per account)

**Default sections** come from the account type and the starter-chart code ranges:

| Account | Statement section | Cash-flow class |
|---|---|---|
| Assets 10xx | Cash | Cash |
| Other assets below 15xx | Current assets | Operating (working capital) |
| Assets 15xx–19xx, debit-normal | Non-current assets | Investing |
| Assets 15xx–19xx, credit-normal (e.g. accumulated depreciation) | Non-current assets | **Non-cash** (added back) |
| Liabilities 22xx–29xx | Non-current liabilities | Financing |
| Other liabilities | Current liabilities | Operating |
| Equity | Equity | Financing |
| Revenue 41xx–49xx | Other income | — |
| Other revenue | Revenue | — |
| Expenses 5xxx | Cost of sales | — |
| Expenses 7xxx | Other expenses | — |
| Expenses 8xxx–9xxx | Income tax expense | — |
| Other expenses | Operating expenses | — |

- **Overrides:** an accountant can set a different section and cash-flow class per account (`set_account_report_mapping`). Overrides are audit-logged, and can be reset to the default.

**❓ Questions for the CPA:**
- Loans: should the current portion be split out?
- Is the indirect method acceptable, or is the direct method preferred?
- How should interest and dividends be classified?
- Non-cash transactions (e.g. equipment bought on a loan) currently appear in both investing and financing. Should they be shown only in a note instead?
- Should prior-period adjustments to retained earnings be presented as financing?

## 4. Period close and access

- **Firm staff** assigned to the client can see any period. Reports that include open periods are marked **Preliminary**.
- **Client users** see statements (income statement, balance sheet and cash flow) only up to the last date through which **every** period is closed (soft-closed or locked). This is enforced in the database (`report_closed_through`). They get no drill-down into journal entries.
- Other clients, and firm admins without an assignment, can't run the reports.

## 5. Drill-down

Report line → account detail (the posted lines for that range) → journal entry → **source document**:
- sales invoice or receipt
- purchase bill or supplier payment
- stock movement
- payroll (only with a payroll grant)
- client transaction
- the reversed entry

Every target page checks access again.

## 6. Rounding, comparisons, exports

- **Exact amounts:** stored and computed to the centavo, using integer arithmetic (no floating point).
- **Whole-peso presentation (optional):** each line is rounded half away from zero, and subtotals are computed from the rounded lines. If rounded lines no longer add up, or the statement would no longer balance, a **"Rounding difference"** line makes it agree.
- **Comparisons:** the previous period (the same number of whole months, or of days) or the same period last year, shown with the change.
- **CSV export:**
  - The header states the client, the period, and whether the figures are preliminary.
  - It is UTF-8 with a BOM.
  - Text that a spreadsheet would run as a formula is neutralized.
