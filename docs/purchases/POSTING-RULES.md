# Purchases, Expenses and Payables: Posting Rules (Phase 8)

**Status:** implemented 2026-10-10, **pending CPA review**. Bills, cash purchases and reimbursements are **recorded** from the documents received.

**No withholding rate, deductibility rule or tax treatment is built in.** All of these come from configuration the firm enters and signs off:

| Configuration | Who enters it | Who approves it | Effect before approval |
|---|---|---|---|
| **Withholding codes** (firm-wide, versioned): code, rate, base (net of VAT or gross), legal basis, effective dates | A reviewer or manager | A **different** reviewer or manager signs it off | A bill using it **cannot be posted** |
| **Purchase categories** (per client): treatment (inventory, fixed asset, prepayment or expense) and the account it posts to | Accountant, reviewer or manager | A **different** reviewer or manager | It cannot be used on a bill |
| **Capitalization threshold** (optional accountant policy) | — | — | Expense lines at or above it are **flagged for review**; nothing changes automatically |
| **Input VAT** | — | — | The rate comes from `tax_rates` (12%, **pending CPA sign-off**). Bills store the rate and status they used. |

**Withholding codes start EMPTY.** A signed-off code never changes; a change of rate is a new version.

## 1. Amounts (computed by the database)

- **Lines** use the same rules as sales: (quantity × unit price) − discount; VAT added or extracted per line; rounding to the centavo, half away from zero.
- **VAT breakdown:** each VATable line records whether it is goods, services or capital goods, as the document shows.
- **Withholding per line** = round(base × rate, 2), where the base is net of VAT or gross, as the signed-off code says. Each line stores the code version, rate and base used.
- **Amount to pay** = total − withholding.

## 2. Journal entries

| Document | Debit | Credit |
|---|---|---|
| **Bill / reimbursement** (posted) | Category account = net (per account). Input VAT = VAT. | Withholding taxes payable = withholding. Accounts payable = total − withholding. |
| **Cash purchase** | Same as above | The cash/bank account instead of payables |
| **Supplier payment** | Accounts payable = amount applied to bills. Advances to suppliers = the unapplied rest. | Cash/bank = amount paid |
| **Cancellation of a posted document** | A **reversing entry**. The original stays; nothing is deleted. | |

**Default accounts:**
- 2010 Accounts Payable
- 1310 Input Tax
- 2110 Withholding Taxes Payable
- 1130 Advances to Suppliers (new)

**Default categories (proposed, need approval):**
- **Inventory:** 5020 Purchases, 1210 Raw materials
- **Expenses:** 60xx accounts
- **Fixed asset:** 1500 Equipment
- **Prepayment:** 1300 Prepaid expenses

❓ **CPA:**
- **Withholding timing:** is withholding recognized when the bill is posted (as built), or should it be at payment?
- **Input VAT:** may all VAT on a valid document be recorded as input VAT? There is no "non-creditable" treatment yet.
- **Reimbursements:** what is the VAT treatment of receipts not issued in the client's name?
- **Purchases vs inventory:** periodic (5020 Purchases) or perpetual (1210 inventory accounts)?

## 3. Controls (Phase 8 gate)

- **No duplicate supplier bills:**
  - One live bill per supplier and invoice number (any letter case).
  - A retried request returns the same bill.
  - Posting twice returns the same journal entry.
  - An intake transaction becomes at most one live bill, and can't also be booked by a journal entry.
- **Payables, allocations and ledger agree:**
  - At posting, bills are locked and balances re-checked, so two payments can't over-pay one bill.
  - The payables subledger is compared with the general ledger on any date (`ap_reconciliation`).
  - A cancellation can't be dated before the last related posting.
- **Maker-checker:** a different reviewer or manager posts each document.
- **Immutability:** posted documents and their lines are frozen, even against direct SQL.
- **Audit:** every change and every status change is logged.
- **Withholding data:** `withholding_summary` lists the base and the tax withheld per payee and code for any period. It's the raw data for certificates and returns in a later, CPA-approved phase. No form is generated.
