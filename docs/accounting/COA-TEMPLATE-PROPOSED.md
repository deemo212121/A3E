# Starter Chart of Accounts: PROPOSED (`PH-SME-V0`)

> **Status: PROPOSED, pending accountant approval.** The Phase 5 instruction refers to "the approved chart of accounts". No chart had been approved, so a **generic starter** was seeded as data (`coa_templates` / `coa_template_accounts`, migration `20261010140200`). It is **not** a BIR-prescribed chart. The engine works with **any** chart: the accountant can approve this one, edit it, or supply a different one, and no code changes are needed.

57 accounts. ⊕ = added 2026-10-10 (migration `20261010150100`) after reviewing one client's actual books ([FIRM-WORKBOOK-REVIEW.md](FIRM-WORKBOOK-REVIEW.md)). Clients that already have a chart are not changed; add accounts to them individually.

| Code | Name | Type | Normal | Postable |
|---|---|---|---|---|
| 1000 | Assets | asset | debit | header |
| 1010 | Cash on Hand | asset | debit | ✓ |
| 1015 | Petty Cash Fund ⊕ | asset | debit | ✓ |
| 1020 | Cash in Bank | asset | debit | ✓ |
| 1100 | Accounts Receivable | asset | debit | ✓ |
| 1110 | Allowance for Doubtful Accounts | asset (contra) | credit | ✓ |
| 1120 | Advances to Employees ⊕ | asset | debit | ✓ |
| 1200 | Inventory | asset | debit | ✓ |
| 1210 | Raw Materials ⊕ | asset | debit | ✓ |
| 1300 | Prepaid Expenses | asset | debit | ✓ |
| 1310 | Input Tax (placeholder) | asset | debit | ✓ |
| 1320 | Creditable Withholding Tax (placeholder) | asset | debit | ✓ |
| 1500 | Property and Equipment | asset | debit | ✓ |
| 1510 | Accumulated Depreciation | asset (contra) | credit | ✓ |
| 2000 | Liabilities | liability | credit | header |
| 2010 | Accounts Payable | liability | credit | ✓ |
| 2020 | Accrued Expenses | liability | credit | ✓ |
| 2030 | Salaries and Wages Payable ⊕ | liability | credit | ✓ |
| 2100 | Output Tax (placeholder) | liability | credit | ✓ |
| 2105 | VAT Payable (placeholder) ⊕ | liability | credit | ✓ |
| 2110 | Withholding Taxes Payable (placeholder) | liability | credit | ✓ |
| 2120 | SSS Contributions Payable ⊕ | liability | credit | ✓ |
| 2130 | PhilHealth Contributions Payable ⊕ | liability | credit | ✓ |
| 2140 | Pag-IBIG Contributions Payable ⊕ | liability | credit | ✓ |
| 2150 | SSS Loans Payable (employee deductions) ⊕ | liability | credit | ✓ |
| 2160 | Pag-IBIG Loans Payable (employee deductions) ⊕ | liability | credit | ✓ |
| 2200 | Loans Payable | liability | credit | ✓ |
| 3000 | Equity | equity | credit | header |
| 3010 | Capital | equity | credit | ✓ |
| 3020 | Drawings | equity (contra) | debit | ✓ |
| 3100 | Retained Earnings | equity | credit | ✓ |
| 4000 | Revenue | revenue | credit | header |
| 4010 | Sales | revenue | credit | ✓ |
| 4020 | Service Revenue | revenue | credit | ✓ |
| 4030 | Sales Returns and Allowances | revenue (contra) | debit | ✓ |
| 4100 | Other Income | revenue | credit | ✓ |
| 5000 | Cost of Sales | expense | debit | header |
| 5010 | Cost of Goods Sold | expense | debit | ✓ |
| 5020 | Purchases ⊕ | expense | debit | ✓ |
| 6000 | Operating Expenses | expense | debit | header |
| 6010 | Salaries and Wages | expense | debit | ✓ |
| 6012 | Employer Contributions (SSS, PhilHealth, Pag-IBIG) ⊕ | expense | debit | ✓ |
| 6014 | Employee Benefits ⊕ | expense | debit | ✓ |
| 6020 | Rent Expense | expense | debit | ✓ |
| 6030 | Utilities Expense | expense | debit | ✓ |
| 6040 | Supplies Expense | expense | debit | ✓ |
| 6050 | Depreciation Expense | expense | debit | ✓ |
| 6060 | Professional Fees | expense | debit | ✓ |
| 6070 | Bank Charges | expense | debit | ✓ |
| 6080 | Repairs and Maintenance ⊕ | expense | debit | ✓ |
| 6090 | Fuel and Oil ⊕ | expense | debit | ✓ |
| 6100 | Transportation and Travel ⊕ | expense | debit | ✓ |
| 6110 | Communication Expense ⊕ | expense | debit | ✓ |
| 6120 | Taxes and Licenses ⊕ | expense | debit | ✓ |
| 6130 | Meals Expense ⊕ | expense | debit | ✓ |
| 6140 | Representation Expense ⊕ | expense | debit | ✓ |
| 6900 | Miscellaneous Expense | expense | debit | ✓ |

**Notes for the accountant**
- **Purchases vs inventory:** the client's books expense goods bought to "Raw Material"/purchases columns. Both 5020 Purchases (periodic method) and 1210 Raw Materials (perpetual) are offered; please say which the Firm uses.
- **Payroll liabilities** are split by agency so each remittance clears its own account; contribution amounts are typed in, never computed.
- Accounts marked "(placeholder)" are **recording accounts only**. No tax computation exists, and none will be built until the tax rules are signed off (docs 08 and 13).
- **Corporations vs sole proprietors:** "Capital" and "Drawings" suit sole proprietors. Corporations usually need Share Capital, APIC and similar accounts instead. Please advise whether separate templates are wanted.
- Once used in a posted entry, an account's **code, type and normal balance are fixed**; it can only be renamed or deactivated.

**Approval:** ☐ Approved as-is ☐ Approved with changes (attach) ☐ Replace with: ________. Name / date: ________
