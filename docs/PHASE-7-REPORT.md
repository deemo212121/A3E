# Phase 7 Report — Sales and Receivables

**Date:** 2026-10-10
**Status:** Submitted for review. **The SQL has NOT been applied to the dev database yet:** the owner runs it manually (§4). Until then the new screens will show database errors.

## 1. What was built

| Requirement | Delivered |
|---|---|
| Customers | The Phase 6 customer records, plus credit terms (days) |
| Sales transactions / invoice records / line items | Records of invoices the client **issued** (its own numbers), with lines: quantity, unit price, discount, tax class, revenue account |
| Tax classification | Per line: VATable, zero-rated, exempt, or no VAT (non-VAT seller). VAT is computed from the `tax_rates` table: 12%, **pending CPA sign-off**, legal basis recorded. Each invoice stores the rate and status it used. |
| Discounts, credit sales | Per-line discounts; cash or credit sales; due date from the customer's terms or entered directly |
| Customer receipts, allocations, balances | Receipts with withholding tax as stated (BIR Form 2307), applied to one or many invoices. Overpayments go to customer advances. Outstanding balances, aging and statements can be shown as of any date. |
| Posting to the accounting engine | Documented rules ([sales/POSTING-RULES.md](sales/POSTING-RULES.md)). Posting creates a balanced, numbered journal entry, and only a reviewer other than the preparer can post. |
| Credit notes, returns, cancellations, corrections | Credit notes (never more than the balance); cancellation by reversing entry, with an order rule (receipts and credits first) and a date rule; return to the preparer for correction |
| Audit history | Row audit on all sales tables, a status history per document, and a "History" panel on each page |
| Invoice/PDF vs BIR e-invoicing | **Separated by not issuing invoices at all (D-01).** There is no invoice PDF, no e-invoice and no transmission. A printable **statement of account** is labelled "not an invoice or official receipt". |
| Research before compliance claims | Relies on doc 10 (RMC 98-2026, RR 26-2025; researched 2026-10-10). **No compliance is claimed** anywhere. |

**Staff screens:** a Sales & receivables tab with Invoices, Receipts, Balances & aging (with reconciliation), Statement of account and Posting accounts. There are also pages to record and view invoices and receipts, a credit-note form on the invoice page, and "Record as a sales invoice" on an approved client sale in Intake.

## 2. Tests actually run (offline, 2026-10-10)

| Suite | Result |
|---|---|
| `npm run check` (format, lint, typecheck, unit + DB tests, build, secret scan) | **Pass: 22 files, 336 tests** |
| `tests/db/sales.test.ts` | **22/22**. **Totals and rounding:** exclusive and inclusive VAT, discounts, half-up rounding. Bad input is refused, and duplicate or retried invoices are handled. **Posting:** a preparer can't post their own work, the entry lines are exact, retries return the same entry, posted invoices are frozen, and a returned invoice goes back to draft. **Partial payments** (1,000 + 1,000 with 20 withheld), an overpayment going to advances, two receipts racing for one balance (the second is refused), invalid allocations and duplicate receipts. **Credit notes:** over-crediting is refused. **Cancellations:** blocked while receipts exist; a bounced check restores the balance (also checked as of an earlier date); reversal; the number is reusable; backdated cancellation is refused. **Balances:** the subledger equals the GL on 3 dates, aging buckets are correct, and a manual AR entry shows as a difference. **Intake link:** no double booking. **Isolation:** clients can read but not write; other tenants see nothing. |
| `src/lib/sales/calc.test.ts` | **3/3**: the form's live totals match the database for the same cases |
| Mutation checks | All three caught: removing the duplicate-receipt index (1 test fails), removing the over-application check (6 fail), changing the VAT rate (8 fail) |
| **Live database, route and browser tests** | **Not run.** They need the SQL applied first (owner's choice to save tokens). Run on request. |

**Found by the tests and fixed:** backdating an invoice cancellation before a later payment's reversal made the subledger and the ledger disagree for those dates. A date rule now prevents it.

## 3. Open items

- **CPA:** rounding method, discount treatment, which accounts to use for returns/adjustments and advances, and the VAT rate sign-off ([POSTING-RULES.md](sales/POSTING-RULES.md) ❓).
- **Not built:**
  - client-portal view of receivables
  - refunds of customer advances
  - applying an existing advance to a later invoice
  - sales registers/summaries for tax returns (later tax phase)
  - importing e-invoice data
- **D-01 stands:** issuing invoices would need a BIR Permit to Issue and EIS certification (doc 10).

## 4. SQL to run (Supabase → SQL Editor), in this order, one file at a time

1. `supabase/migrations/0021_sales_enums.sql`, run on its own first
2. `supabase/migrations/0022_sales_core.sql`
3. `supabase/migrations/0023_sales_functions.sql`

Each file records itself in the migration history, so `db push` won't re-apply it.
