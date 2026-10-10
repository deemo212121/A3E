# Accounting Test Scenarios: For Accountant Review

> **Status: PENDING ACCOUNTANT SIGN-OFF.** The Phase 5 instruction asks for "accountant-reviewed expected results". The expected results below were computed by hand from double-entry arithmetic and are **hard-coded** in the automated tests (`tests/db/accounting-engine.test.ts`, `tests/integration/accounting.live.test.ts`). **No qualified accountant has reviewed them yet.**
>
> All data is synthetic. No tax is computed (VAT and withholding are deliberately absent).

Accounts are from the **PROPOSED** starter chart (`PH-SME-V0`, see [COA-TEMPLATE-PROPOSED.md](COA-TEMPLATE-PROPOSED.md)). Fiscal year: 2026-01-01 to 2026-12-31, 12 monthly periods.

## Scenario S1: January transactions

| JE | Date | Type | Memo | Debit | Credit |
|---|---|---|---|---|---|
| 1 | 2026-01-01 | opening | Owner's initial investment | 1020 Cash in Bank 500,000.00 | 3010 Capital 500,000.00 |
| 2 | 2026-01-05 | general | Services billed on account (source: sales_invoice SI-DEMO-0001) | 1100 Accounts Receivable 120,000.00 | 4020 Service Revenue 120,000.00 |
| 3 | 2026-01-10 | general | January rent | 6020 Rent Expense 25,000.00 | 1020 Cash in Bank 25,000.00 |
| 4 | 2026-01-15 | general | Equipment, part bank loan | 1500 Property and Equipment 150,000.00 | 1020 Cash in Bank 50,000.00; 2200 Loans Payable 100,000.00 |
| 5 | 2026-01-20 | general | Collection from customer (source: official_receipt OR-DEMO-0001) | 1020 Cash in Bank 80,000.00 | 1100 Accounts Receivable 80,000.00 |
| 6 | 2026-01-25 | general | Utilities accrued | 6030 Utilities Expense 4,567.89 | 2020 Accrued Expenses 4,567.89 |
| 7 | 2026-01-31 | general | January salaries | 6010 Salaries and Wages 60,000.00 | 1020 Cash in Bank 60,000.00 |

**Expected trial balance as of 2026-01-31**

| Account | Debit | Credit |
|---|---:|---:|
| 1020 Cash in Bank (500,000 + 80,000 − 25,000 − 50,000 − 60,000) | 445,000.00 | |
| 1100 Accounts Receivable (120,000 − 80,000) | 40,000.00 | |
| 1500 Property and Equipment | 150,000.00 | |
| 2020 Accrued Expenses | | 4,567.89 |
| 2200 Loans Payable | | 100,000.00 |
| 3010 Capital | | 500,000.00 |
| 4020 Service Revenue | | 120,000.00 |
| 6010 Salaries and Wages | 60,000.00 | |
| 6020 Rent Expense | 25,000.00 | |
| 6030 Utilities Expense | 4,567.89 | |
| **Totals** | **724,567.89** | **724,567.89** |

- Sum of all posted line debits = sum of all posted line credits = **939,567.89**.
- Cash in Bank running balance (general ledger): JE1 500,000.00 → JE3 475,000.00 → JE4 425,000.00 → JE5 505,000.00 → JE7 **445,000.00**.
- Trial balance as of 2026-01-10 (later entries excluded): Cash 475,000.00; AR 120,000.00; Capital 500,000.00; Service Revenue 120,000.00; Rent 25,000.00.

## Scenario S2: Error, reversal, correction

| JE | Date | Effect |
|---|---|---|
| 8 | 2026-02-03 | **Error:** Supplies Expense 1,000.00 / Cash in Bank 1,000.00 (should have been 100.00). Source: purchase_invoice PI-DEMO-0001 |
| 9 | 2026-02-04 | **Reversal of JE8:** Cash in Bank 1,000.00 / Supplies Expense 1,000.00. JE8 becomes "reversed", and both entries are linked to each other. |
| 10 | 2026-02-04 | **Correction:** Supplies Expense 100.00 / Cash in Bank 100.00. The same source document is reused, which is allowed only because JE8 was reversed. |

**Expected as of 2026-02-28:** Supplies Expense **100.00**; Cash in Bank **444,900.00**. The error nets to zero, and debits still equal credits.

## Scenario S3: one month of a VAT-registered trading client (in the Firm's format)

Added 2026-10-10 after reviewing one client's workbooks (see [FIRM-WORKBOOK-REVIEW.md](FIRM-WORKBOOK-REVIEW.md)). It records a month the way their books do: cash disbursements, cash receipts, semi-monthly payroll and an imprest petty cash fund. **All names, TINs and amounts are invented.** The 12% split (amount ÷ 1.12) copies the Firm's spreadsheet practice, and the payroll deductions are **illustrative, not contribution tables**. The platform computes **no** tax: every amount is typed by the preparer. Test: `tests/db/business-month.test.ts`.

| Date | Entry | Debit | Credit |
|---|---|---|---|
| 09-01 | Opening capital | Cash in Bank 500,000.00 | Capital 500,000.00 |
| 09-01 | Establish petty cash fund (CV-0001) | Petty Cash Fund 40,000.00 | Cash in Bank 40,000.00 |
| 09-03 | Fuel, VAT supplier (OR-1001, TIN 111-222-333-00000) | Fuel and Oil 2,000.00; Input Tax 240.00 | Cash in Bank 2,240.00 |
| 09-05 | Spare parts, non-VAT supplier (SI-2001) | Repairs and Maintenance 600.00 | Cash in Bank 600.00 |
| 09-08 | Raw materials (SI-3001) | Purchases 100,000.00; Input Tax 12,000.00 | Cash in Bank 112,000.00 |
| 09-10 | Customer collection (SI-0451) | Cash in Bank 336,000.00 | Sales 300,000.00; Output Tax 36,000.00 |
| 09-12 | Cash advance to an employee | Advances to Employees 1,000.00 | Cash in Bank 1,000.00 |
| 09-15 | Payroll 1–15 (no deductions in this half, as in the Firm's books) | Salaries 30,000.00 | Cash in Bank 30,000.00 |
| 09-20 | Petty cash replenishment | Meals 1,250.00; Supplies 860.50; Repairs 2,349.75; Employee Benefits 1,000.00 | Cash in Bank 5,460.25 |
| 09-22 | **Error:** fuel entered twice (OR-1002) | Fuel and Oil 1,000.00; Input Tax 120.00 | Cash in Bank 1,120.00 |
| 09-25 | **Reversal** of the 09-22 entry; the reversal lines keep the supplier, TIN and OR number | Cash in Bank 1,120.00 | Fuel and Oil 1,000.00; Input Tax 120.00 |
| 09-30 | Payroll 16–30. Employee shares: SSS 950, PhilHealth 600, Pag-IBIG 200; SSS loan 500; cash advance 1,000. Employer shares: SSS 1,900, PhilHealth 600, Pag-IBIG 200 | Salaries 30,000.00; Employer Contributions 2,700.00 | SSS Payable 2,850.00; PhilHealth Payable 1,200.00; Pag-IBIG Payable 400.00; SSS Loans Payable 500.00; Advances to Employees 1,000.00; Cash in Bank (net pay) 26,750.00 |
| 09-30 | Remit PhilHealth and Pag-IBIG | PhilHealth Payable 1,200.00; Pag-IBIG Payable 400.00 | Cash in Bank 1,600.00 |

**Expected trial balance as of 2026-09-30:**

| Account | Balance |
|---|---|
| 1015 Petty Cash Fund | 40,000.00 (unchanged by replenishment) |
| 1020 Cash in Bank | 616,349.75 |
| 1120 Advances to Employees | 0.00 |
| 1310 Input Tax | 12,240.00 |
| 5020 Purchases | 100,000.00 |
| 6010 Salaries and Wages | 60,000.00 |
| 6012 Employer Contributions | 2,700.00 |
| 6014 Employee Benefits | 1,000.00 |
| 6040 Supplies Expense | 860.50 |
| 6080 Repairs and Maintenance | 2,949.75 |
| 6090 Fuel and Oil | 2,000.00 (the duplicate nets to zero) |
| 6130 Meals Expense | 1,250.00 |
| **Debit-balance total** | **839,350.00** |
| 2100 Output Tax | 36,000.00 |
| 2120 SSS Contributions Payable | 2,850.00 (not yet remitted) |
| 2130 PhilHealth / 2140 Pag-IBIG Payable | 0.00 / 0.00 |
| 2150 SSS Loans Payable | 500.00 |
| 3010 Capital | 500,000.00 |
| 4010 Sales | 300,000.00 |
| **Credit-balance total** | **839,350.00** |

Also tested:
- TINs typed as `123456789`, `123 456 789 001` or `123-456-789-00000` are stored in dashed form.
- Malformed TINs are rejected, as is a TIN without a name.
- The supplier, TIN and receipt fields cannot be changed once posted, even by the database owner.
- The fields are invisible to users of other clients.
- The general ledger lists the receipt number and supplier for each line.

## Controls verified (expected behaviour)

| # | Control | Expected |
|---|---|---|
| C1 | Unbalanced, single-line or zero-total entry | Cannot be submitted or posted |
| C2 | Amounts with 3 decimals, negatives, separators or exponents | Rejected (never rounded silently) |
| C3 | A line with both a debit and a credit | Rejected |
| C4 | Posted entries and their lines | Cannot be edited or deleted by anyone; corrected only by reversal |
| C5 | Same request replayed (same idempotency key) | One entry, never two |
| C6 | Second live entry for the same source document | Refused while the first is live |
| C7 | Approving twice, or concurrently | Posted once and numbered once |
| C8 | Entry numbers | Sequential with no gaps, per client per fiscal year; drafts and voids consume no number |
| C9 | Preparer approving own entry | Refused (maker-checker) |
| C10 | Locked period | No drafting or posting. Reversals of its entries must be dated in an open period. |
| C11 | Soft-closed period | Adjusting entries and reversals only |
| C12 | Locking with pending drafts or submitted entries | Refused |
| C13 | Reopening a locked period | Manager only, with a written reason |
| C14 | A reversal | Reverses at most once; cannot itself be reversed |

## Policy choices for the accountant to confirm

| Decision | Implemented default | Confirm or change |
|---|---|---|
| **D-08** Prior-period corrections | Reverse into an **open** period (the reversal date must not be before the original's). Reopening a locked period needs a manager and a reason. | ☐ |
| **D-10** Entry numbering | **Gapless per client per fiscal year**, assigned at posting | ☐ |
| Reversal approval | A reviewer or manager reverses in **one step** (no second approver). It is fully audited, and the reversal is excluded from the maker-checker CHECK. | ☐ |
| Soft-closed period | Accepts **adjusting** entries and reversals only | ☐ |
| Who maintains the chart of accounts | Manager, reviewer, accountant (assigned). Bookkeepers cannot. | ☐ |
| Who opens fiscal years / closes periods | Reviewer or manager. **Locking:** manager only. | ☐ |
| Rounding | No rounding anywhere: amounts must have at most 2 decimals | ☐ |
| S3 recording pattern | Is S3 how the Firm wants these transactions booked? Specifically: purchases expensed to "Purchases" vs inventory; petty cash as an imprest fund; payroll liabilities by agency; employee loans as payables | ☐ |

## Sign-off

| | Name | Signature | Date |
|---|---|---|---|
| Reviewed by (CPA) | | | |
| Corrections noted | | | |
