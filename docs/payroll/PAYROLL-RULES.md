# Payroll and Statutory Contributions: Rules (Phase 10)

**Status:** implemented 2026-10-10.
- **The computation engine is built. It is NOT validated.**
- Nothing here may be called accurate or compliant until a **qualified payroll/accounting reviewer** has checked it against the official issuances with real (sample) cases.
- **Use sample/test data only until then.**

## 1. Calculation is kept separate from approval

| What | Built in? | Who provides / approves |
|---|---|---|
| SSS contribution table | **No (ships empty)** | A reviewer or manager enters each version from the official issuance with its legal basis and effective dates. A **different** reviewer or manager signs it off. |
| PhilHealth premium (rate, floor, ceiling, split) | **No** | Same |
| Pag-IBIG contribution (rates, ceiling) | **No** | Same |
| Withholding tax on compensation (table per pay frequency; whether employee contributions are deducted first) | **No** | Same |
| Which earnings are taxable / in each contribution base | **No** | Set per pay item by a preparer and **approved by a second person** |
| Overtime and other premiums (multipliers) | **No** | Per pay item (labor policy) |
| Daily and hourly rates | **No divisor is assumed** | Entered per employee rate |
| Exemption from withholding (e.g. minimum wage earners) | **No** | Per employee, with a recorded reason |

**Signed-off tables:**
- They never change. A new rate is a new version.
- Only one signed-off version of a table may be in effect on any date.
- A payroll **cannot be submitted or posted** unless each of the four tables has a signed-off version in effect on its period end.
- Each payslip records which table versions it used.

### Official sources to verify against: PENDING VERIFICATION

Obtain the **current** issuances and tables from the agencies. The list below says where the rules come from. It does not state the rules themselves.

| Area | Primary law (to confirm) | Implementing issuances | Status |
|---|---|---|---|
| SSS contributions | Republic Act No. 11199 (Social Security Act of 2018) | Current SSS contribution schedule / circular | ❓ PENDING VERIFICATION |
| PhilHealth premiums | Republic Act No. 11223 (Universal Health Care Act) | Current PhilHealth premium circular | ❓ PENDING VERIFICATION |
| Pag-IBIG contributions | Republic Act No. 9679 (HDMF Law of 2009) | Current HDMF circular on contribution rates and the maximum fund salary | ❓ PENDING VERIFICATION |
| Withholding on compensation | NIRC as amended (incl. RA 10963, TRAIN) | Current BIR revenue regulations and withholding tax tables | ❓ PENDING VERIFICATION |
| Overtime, holiday and night premiums, 13th month | Labor Code; PD 851 | DOLE issuances | ❓ PENDING VERIFICATION (not computed automatically) |

## 2. How a payslip is computed (engine, PENDING VERIFICATION)

1. **Lines:**
   - Days or hours × the employee's daily or hourly rate in effect on the **period end** × the item's multiplier, rounded to the centavo (half away from zero).
   - Alternatively, an amount is entered directly.
   - Earnings may be negative (absences, corrections). Deductions are positive.
2. **Gross pay** = sum of earnings.
   - **Bases:** the sum of the earnings flagged for each base.
   - **Taxable earnings:** the sum of taxable earnings.
3. **Contributions are monthly amounts, computed month-to-date.** Bases from this payroll plus the earlier **posted** payrolls of the same month go through the table, minus what earlier payrolls already took. This handles the following:
   - semi-monthly payrolls (the second half "tops up")
   - later adjustments in the month
   - ceilings across the month
4. **Table methods:**
   - **Fixed table:** employee, employer and EC amounts per compensation bracket.
   - **Rate table:** employee and employer rates on the base, clamped to [floor, ceiling], with the bracket chosen by the actual base. Each share is rounded to the centavo. ❓ Should the total premium be rounded before splitting?
   - **Graduated (tax):** fixed tax + rate × (taxable − bracket lower bound). The excess part is rounded to the centavo.
5. **Withholding:**
   - The base is this payroll's taxable earnings, less the employee contributions if the signed-off table says so.
   - The table must match the payroll frequency.
   - Exempt employees: 0.
   - ❓ Year-end annualization and adjustment are **not built**.
6. **Net pay** = gross − employee contributions − withholding − other deductions. A negative result blocks submission.

**Termination:**
- Separated employees are not added to payrolls that start after their last day, and can't be added manually.
- The last payroll is marked "final pay". Its basic pay is entered by days.
- ❓ The tax treatment of final pay items needs CPA input.

## 3. Journal entry (one per payroll, dated the period end, aggregate only)

| Debit | Credit |
|---|---|
| Each earning item's expense account (e.g. 6010 Salaries, 6014 Benefits) | SSS payable (2120) = EE + ER + EC |
| Employer contributions expense (6012) = ER + EC, all agencies | PhilHealth payable (2130) = EE + ER |
| | Pag-IBIG payable (2140) = EE + ER |
| | Withholding tax on compensation payable (**2115, new**: kept apart from 2110, which is used for supplier withholding) |
| | Each deduction item's account (e.g. 2150 SSS loans) |
| | Net pay payable (2030) |

**Distinctions:**
- **Employee** deductions reduce net pay.
- **Employer** contributions are an expense, never deducted from pay.
- Liabilities stay apart per agency.
- The ledger has **no employee names**: only totals per account.

**Payments:**
- Net pay and remittances are recorded per payroll and posted by a different approver: Dr the liability / Cr cash or bank.
- Payments can't exceed what is unpaid.

**Cancellation:**
- Cancellation is by reversing entry.
- Payments must be cancelled first.
- Within a month, the latest payroll is cancelled first, because later payrolls' contributions depend on earlier ones.
- Payrolls of a month are posted in order.

## 4. Privacy

- Payroll tables are readable **only with an explicit payroll grant** for the client: *view*, *prepare* or *approve*. Grants are given by a firm manager.
  - Being assigned to the client is **not** enough.
  - Client users can be given *view* only.
  - Firm admins cannot be granted access.
- *Prepare* needs an assigned staff role. *Approve* needs reviewer or manager.
- Payroll history lives in a separate restricted table (`payroll_events`), not in the general intake history.
- The audit log records payroll changes. It is not readable from the application.
- The general ledger shows only aggregate payroll amounts. ❓ Should the trial balance and ledger be restricted further for some clients?

## 5. Reconciliation (the gate)

`payroll_reconciliation(client, as_of)`: for each payroll liability account, compare:
- what posted payrolls still owe (liabilities − posted payments, as of the date)

with:
- the general-ledger balance.

A manual entry to one of those accounts shows up as a difference.
