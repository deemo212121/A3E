# Phase 8 Report — Purchases, Expenses and Payables

**Date:** 2026-10-10
**Status:** Submitted for review. **The SQL has NOT been applied yet:** the owner runs it manually (§4).
**Gate:** *Walang duplicate supplier bills at tugma ang payables, payment allocations, at ledger* (no duplicate supplier bills; payables, payment allocations and the ledger agree). **Met in offline tests (§2).** Live tests are pending the SQL.

## 1. What was built

| Requirement | Delivered |
|---|---|
| Supplier invoices, purchases, operating expenses | Bills (pay later) and cash purchases (paid on the spot), with lines, discounts and tax class. VATable lines record whether they are goods, services or capital goods. |
| Reimbursements | Payee can be an employee (new customer/supplier type); each line keeps the original receipt's supplier, TIN and number |
| Supplier payments, allocations | Payments applied to one or more bills; overpayments go to "Advances to suppliers" |
| Supporting documents | Phase 6 documents attached to bills |
| Withholding-tax data capture | Per line: code version, rate, base and amount. A withholding summary per payee and code for any period. |
| Inventory / fixed assets / prepayments / expenses | **Purchase categories**, each with a treatment and an account, approved by a reviewer other than the proposer. An optional **capitalization threshold** flags expense lines for review. |
| No invented rates or treatments; verified, versioned configuration | **Withholding codes start empty**. They are entered with a legal basis and **signed off by a different person**, and a signed-off code never changes (a new rate is a new version). A bill using an unsigned code **cannot be posted**. Input VAT uses the same `tax_rates` table, still pending sign-off. |
| Posting to AP and the general ledger | Documented rules ([purchases/POSTING-RULES.md](purchases/POSTING-RULES.md)); maker-checker posting |
| Reversals | Cancellation by reversing entry: payments must be cancelled first, and backdating is blocked |

**Staff screens:** a Purchases & payables tab with five sections:
- Bills & expenses
- Payments
- Payables & aging (with reconciliation)
- Withholding (summary, plus entering and signing off codes)
- Categories & accounts

There are also forms to record bills and payments (live totals, VAT and withholding preview) and detail pages.

## 2. Tests actually run (offline, 2026-10-10)

| Suite | Result |
|---|---|
| `npm run check` (format, lint, typecheck, unit + DB tests, build, secret scan) | **Pass: 23 files, 357 tests** |
| `tests/db/purchases.test.ts` | **21/21**. Details below. |
| Mutation checks | Removing the duplicate-bill index, the over-payment check, or the sign-off requirement each makes a test fail |
| **Live database, page and browser tests** | **Not run.** They need the SQL applied first. |

What `tests/db/purchases.test.ts` covers:
- **Configuration:** only a reviewer or manager can enter a withholding code, and a different one must sign it off. Signed-off codes are immutable and versioned. Categories need a second person's approval.
- **VAT breakdowns:** goods, services, exempt and non-VAT lines; the ÷1.12 VAT-inclusive case.
- **Treatment:** fixed asset, prepayment and expense lines post to their own accounts, and the capitalization flag works.
- **Withholding:** on net and on gross amounts. Posting is blocked while a code isn't signed off, and a code that isn't in effect yet can't be used. The summary is checked.
- **Gate, duplicates:** duplicate supplier bills are refused (another supplier may use the same number), and retries and repeated posting don't double up.
- **Payments:** partial payments, an overpayment becoming an advance, two payments racing for one bill (the second is refused), invalid allocations and duplicate payment numbers.
- **Cash purchases** stay out of payables. **Reimbursements** to an employee work end to end.
- **Reversals:** blocked while payments exist, backdating is blocked, and the bill number becomes reusable.
- **Gate, reconciliation:** payables equal the GL on 5 dates, and a manual entry shows up as a difference.
- **Intake link:** a transaction can't be booked twice. **Isolation:** other clients see nothing, and nobody can write directly.

## 3. Open items

- **CPA questions** are listed in [POSTING-RULES.md](purchases/POSTING-RULES.md) ❓: withholding timing, input VAT, reimbursement VAT, and purchases vs inventory.
- **The firm must enter and sign off its withholding codes.** None are included; we don't invent rates.
- **Not built:**
  - supplier debit memos / returns (use cancellation for now)
  - applying an existing advance to a later bill
  - BIR Form 2307 certificates and withholding returns (a later tax phase)
  - client-portal view of payables

## 4. SQL to run (Supabase → SQL Editor), in order, one file at a time

If you haven't yet, run the Phase 7 files (`0021`, `0022`, `0023`) first. Then:

1. `supabase/migrations/0024_purchases_enums.sql`, on its own
2. `supabase/migrations/0025_purchases_core.sql`
3. `supabase/migrations/0026_purchases_functions.sql`
