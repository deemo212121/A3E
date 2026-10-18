# Phase 11 Report: Financial Statements and Reconciliation

**Date:** 2026-10-18
**Status:** Submitted for review. **The SQL has NOT been applied yet.** The owner runs it manually (§5).

## 1. What was built

| Requirement | Delivered |
|---|---|
| Trial balance | Opening balance, period debits and credits, and closing balance per account, with a balance check. (The Phase 5 as-of trial balance stays.) |
| General-ledger reports | Account detail for any range, from every report line, with links to the entry and the source document. (The Phase 5 general ledger stays.) |
| Income statement | Revenue, cost of sales, gross profit, operating expenses, other income/expenses, income tax as recorded, net profit. Closing entries excluded. |
| Balance sheet | Current/non-current assets and liabilities, and equity. Profit not yet closed is shown in equity. Check: assets = liabilities + equity. |
| Cash flow statement | Indirect method, classified per account. Check: opening + net change = closing cash. |
| AR / AP aging | From the sales and purchases subledgers |
| Reconciliation reports | Summary of the trial balance check, plus AR, AP, inventory and payroll subledgers against the ledger |
| Posted data as the source | One read model over posted entries. Drafts are excluded and reversals net to zero. |
| Policies and cash-flow assumptions | [reports/ACCOUNTING-POLICIES.md](reports/ACCOUNTING-POLICIES.md) (PROPOSED, PENDING CPA REVIEW). Default classification is overridable per account and audit-logged. |
| Permissions and period close | Staff see every period; anything in an open period is marked **Preliminary**. **Client users only see closed periods**, enforced in the database. Other tenants and unassigned admins get nothing. |
| Drill-down | Report line → account detail → journal entry → source document (sales, purchases, inventory, payroll with a grant, intake, reversals) |
| Filters, exports, rounding, comparisons | Report, from/to, comparison (previous period or same period last year, with the change), whole-peso rounding with balancing lines, show zero balances, and **CSV download** (also in the portal) |
| No tax from accounting profit | Stated on the income statement and in the policies doc. Income tax is shown only as recorded. |

**Screens:**
- Staff **Reports** tab: one page with all seven reports, plus account drill-down.
- Client portal: **Financial statements** (income statement, balance sheet, cash flow), limited to closed periods.

## 2. Tests actually run (2026-10-18)

| Suite | Result |
|---|---|
| `npm run check` (format, lint, typecheck, unit + DB tests, build, secret scan) | **Pass: 28 files, 414 tests** |
| `tests/db/reports.test.ts` | **7/7** against real postings across two fiscal years (hand-worked figures in the file header) |
| `src/lib/reports/reports.test.ts` and source-link test | **11/11**: statements, rounding, comparison periods, CSV escaping, drill-down links |
| Mutation checks | Each of these makes tests fail: removing the closing-entry exclusion, the posted-only filter, or the client period-close rule |
| Cloudflare build | Builds. Worker size 2,886 KiB compressed (free-plan limit 3,072 KiB) |
| **Live database tests** | **Not run.** They need the SQL applied first. |

What the database test covers:
- **Opening balances:** an opening entry, and the next year opening from the prior year's balances.
- **Period movements:** checked line by line.
- **Year-end closing:** 2025 still shows a profit of 12,000 on the income statement, and it sits in retained earnings on the balance sheet.
- **Excluded entries:** a draft is excluded, and a reversed entry nets to zero.
- **Statement figures:** the balance sheet balances (102,499.50); the cash flow ties 42,000 → 72,999.50.
- **Mapping:** an override changes the statement, and resetting it restores the default.
- **Access:** the client sees figures only after the periods are closed; other tenants are refused.

## 3. Open items (CPA)

The questions are listed in ACCOUNTING-POLICIES.md:
- the framework (PFRS for SMEs or Small Entities)
- loan current portion
- direct vs indirect cash flow
- interest and dividend classification
- non-cash transactions
- prior-period adjustments

## 4. Not built

- PDF export (use the browser's print or the CSV for now)
- Notes to the financial statements
- Statement of changes in equity
- Multi-year comparatives beyond one comparison column
- Budget vs actual

## 5. SQL to run (Supabase → SQL Editor)

1. `supabase/migrations/0033_reporting.sql`
2. If not yet done: `supabase/migrations/0034_beta_disable_staff_mfa.sql`
