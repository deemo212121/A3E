# Phase 10 Report: Payroll and Statutory Contributions

**Date:** 2026-10-10
**Status:** Submitted for review. **The SQL has NOT been applied yet.** The owner runs it manually (§5).
**Gate:** *Verified ang sample computations at correct ang payroll liabilities and employer expenses* (sample computations are verified, and payroll liabilities and employer expenses are correct).
- Met **for the engine, with synthetic tables, in offline tests (§2).** Every figure was worked by hand and checked.
- **Real statutory tables have not been entered or verified.** Qualified payroll/accounting review is **required before production** (§3).

## 1. What was built

| Requirement | Delivered |
|---|---|
| Employee records | Employees with government numbers and hire/separation dates, plus **effective-dated pay rates** (monthly or daily basis, with daily and hourly rates) |
| Payroll periods | Monthly or semi-monthly (1–15, 16–end). One active payroll per period, enforced by the database. |
| Earnings, overtime, allowances, deductions | **Pay items:** earning/deduction, unit (amount/days/hours), multiplier, taxable and contribution-base flags. They are **approved by a second person**. |
| Payslips | Per employee: lines, contributions (EE/ER/EC), tax, net pay, the table versions used, and notes (final pay, exemptions). Printable payslip page. |
| Approvals | Draft → submitted → posted. The preparer cannot post. A submitted payroll can be returned with a comment. |
| Payment records | Net pay and remittances per payroll (SSS, PhilHealth, Pag-IBIG, withholding, other deductions), posted by a second person. No over-payment. |
| Journal entries | One aggregate entry per payroll. EE, ER, expenses and each liability are kept distinct. See [payroll/PAYROLL-RULES.md](payroll/PAYROLL-RULES.md). |
| Verified, effective-dated rules | SSS / PhilHealth / Pag-IBIG / withholding tables **ship empty**. Each version is entered with its legal basis and **signed off by another person**. Signed-off versions are immutable and can't overlap. Payrolls can't be submitted without them. |
| Restricted personal and salary data | **Explicit payroll grants** (view/prepare/approve) given by a firm manager. Assigned accountants and client users see **nothing** without one. The ledger holds aggregates only. |

**Screens:**
- A **Payroll** tab, shown only to users with a grant (and to managers, for granting). Its sections:
  - Runs
  - Employees
  - Liabilities & monthly summary
  - Pay items & accounts
  - Statutory tables (enter and sign off)
  - Access
- A run page: payslip entry, workflow, payments.
- An employee page: rates, separation.
- A payslip page.

## 2. Tests actually run (offline, 2026-10-10)

| Suite | Result |
|---|---|
| `npm run check` (format, lint, typecheck, unit + DB tests, build, secret scan) | **Pass: 25 files, 396 tests** |
| `tests/db/payroll.test.ts` | **18/18** with **synthetic test tables** (labelled "TEST ONLY"), 4 synthetic employees, 3 payrolls |
| Mutation checks | Each of these makes tests fail: removing the duplicate-period index, the month-to-date true-up, the contribution ceiling, centavo rounding (→ truncation), maker-checker, the explicit-grant rule (→ any assigned user), or the cancellation order |
| **Live database, page and browser tests** | **Not run.** They need the SQL applied first. |

What the tests cover:
- **Effective dates:** a raise from the 16th; SSS version 2 from October (version 1 is ended, and overlapping sign-off is refused); September payslips keep version 1.
- **Rounding:** 3.5 h × 187.50 × 1.25 = 820.3125 → 820.31; 46.875 → 46.88; tax 444.531 → 444.53.
- **Floors and ceilings:** PhilHealth floor for a low earner; PhilHealth ceiling hit across the month (81,000 capped at 60,000); Pag-IBIG ceiling; SSS top bracket.
- **Adjustments:** a taxable adjustment in the second half; month-to-date true-up of all contributions.
- **Termination:** separation can't predate an existing payroll. The final pay is entered by days. The employee is excluded from later payrolls and can't be added.
- **Duplicates:** a second payroll for a period is refused (both the function and the database index). Retries and re-posting return the same records. After cancellation, a payroll can be redone.
- **Reconciliation (the gate):** every payroll liability equals the general ledger as of 3 dates, including payments and a cancelled payroll. A manual entry shows up as a difference. The full journal entries are checked line by line (employer expense 9,935.00 = ER 9,875 + EC 60).
- **Privacy:** no access without a grant (accountant, client owner, other tenant, firm admin). Revoking works. View access can't change anything. The ledger shows no employee names.

## 3. Required before production

1. Enter the **real** SSS, PhilHealth, Pag-IBIG and withholding tables from the current official issuances. A second qualified person signs them off.
2. A qualified payroll/accounting reviewer validates the engine against real sample payslips. Open questions (❓) are listed in PAYROLL-RULES.md:
   - rounding of split premiums
   - contribution timing
   - annualization
   - final pay tax
   - overtime premiums
   - whether to restrict the ledger further
3. The firm sets each client's pay items (taxable and base flags) and rates policy.

## 4. Not built (later phases)

- Year-end annualization and BIR Form 2316, alphalists, 1601-C
- Agency remittance forms and files
- 13th month computation
- Leave balances
- Loans amortization schedules
- Weekly and daily pay frequencies
- An employee self-service portal

## 5. SQL to run (Supabase → SQL Editor), in order, one file at a time

First, Phases 7–9 must be applied. Then:

1. `supabase/migrations/20261010200000_payroll_enums.sql`, on its own
2. `supabase/migrations/20261010200100_payroll_core.sql`
3. `supabase/migrations/20261010200200_payroll_functions.sql`
