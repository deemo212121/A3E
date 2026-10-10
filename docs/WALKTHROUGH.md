# What to Check: Click-by-Click Walkthrough

Use this to see and verify what has been built so far. Everything is **fake DEMO data** on the development system.

**Start the app:** run `npm run dev`, then open http://localhost:3000/login.
**Passwords:** see `dev-accounts.local.txt` (run `npm run seed:dev-accounts` for new ones).

Tick each box as you go. If something does not match, write down what you saw.

---

## A. Bookkeeping: sign in as `demo.accountant@example.com` (authenticator already set up)

1. ☐ You land on **My clients**. Only **DEMO Sampaguita Trading** is listed (the accountant is assigned to that one client only).
2. ☐ Click it. You see tabs: **Overview · Journal · Trial balance · General ledger · Chart of accounts · Periods**.
3. ☐ **Chart of accounts:** a list of accounts (1010 Cash on Hand … 6900 Miscellaneous). Headers such as "Assets" are bold.
4. ☐ **Periods:** fiscal year 2026 with 12 months, all "open".
5. ☐ **Journal:** entries **JE 1 to JE 10**, plus two unnumbered ones:
   - "Bank charges (awaiting review)", status **submitted**
   - "Office supplies (draft, unbalanced)", status **draft**
6. ☐ **Trial balance:** set **As of = 2026-01-31** and click **Show**. You should see exactly:

   | Account | Debit | Credit |
   |---|---:|---:|
   | 1020 Cash in Bank | 445,000.00 | |
   | 1100 Accounts Receivable | 40,000.00 | |
   | 1500 Property and Equipment | 150,000.00 | |
   | 2020 Accrued Expenses | | 4,567.89 |
   | 2200 Loans Payable | | 100,000.00 |
   | 3010 Capital | | 500,000.00 |
   | 4020 Service Revenue | | 120,000.00 |
   | 6010 Salaries and Wages | 60,000.00 | |
   | 6020 Rent Expense | 25,000.00 | |
   | 6030 Utilities Expense | 4,567.89 | |
   | **Totals** | **724,567.89** | **724,567.89** |

   ☐ A green message says **"Debits equal credits"**.
7. ☐ Change **As of** to **2026-02-28**. Cash in Bank is now **444,900.00** and Supplies Expense **100.00**. This is the wrong 1,000.00 entry being reversed and replaced by the correct 100.00.
8. ☐ **General ledger:** choose **1020 Cash in Bank**, from 2026-01-01 to 2026-01-31. The running balance goes 500,000.00 → 475,000.00 → 425,000.00 → 505,000.00 → **445,000.00**.
9. ☐ **Journal → JE 8** ("Supplies (wrong amount)"): status **reversed**, with a link to the reversal entry. ☐ There are **no edit or delete buttons**, because posted entries can't be changed.
10. ☐ **Journal → the draft "Office supplies"**: click **Submit for review**. ☐ It is **refused** with "does not balance: debits 500.00 vs credits 450.00".
11. ☐ Fix it in **Edit draft**: change the credit to **500.00**, click **Save draft**, then **Submit for review**. ☐ The status becomes **submitted**.
12. ☐ Try to approve your own entry: there is **no approve button** for the accountant, because preparers can't approve.

## B. Approving: sign in as `demo.manager@example.com` (first time: set up the authenticator app)

13. ☐ You land on the **Review queue**, which lists the submitted entries.
14. ☐ Open "Bank charges (awaiting review)" and click **Approve and post**. ☐ The message says **"Posted as JE 11"** (the next number, no gaps).
15. ☐ Open JE 11 → **Reverse this entry**, enter a reason, and post. ☐ The reversal gets **JE 12**, and JE 11 shows **reversed**.
16. ☐ **Periods:** set **January** to **Locked** with a reason. ☐ Back in the Journal, try to create an entry dated 2026-01-15. It is **refused** ("period is locked").

## C. Security spot-checks

17. ☐ As **demo.owner** (client portal), paste a staff URL such as `/staff/clients/<id>/journal` into the address bar. You get **"You don't have access"**.
18. ☐ As **demo.accountant**, open **DEMO Narra Services Corp.** by URL (copy its id from the admin client list). You get **"Page not found"**, because the accountant isn't assigned to it.

---

## For the accounting firm's CPA (the review that matters)

Please check and sign:
- **[accounting/TEST-SCENARIOS.md](accounting/TEST-SCENARIOS.md):** are the sample entries and expected results correct? Do you agree with the policy choices (corrections, numbering, who can approve)?
- **[accounting/COA-TEMPLATE-PROPOSED.md](accounting/COA-TEMPLATE-PROPOSED.md):** is this chart of accounts acceptable, or what should change?

**Not built yet (so don't look for it):** document uploads, financial statements, BIR forms or tax computations, and a client-side view of the books.
