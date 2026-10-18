# What to Check: Click-by-Click Walkthrough

Use this to see and verify what has been built so far. Everything is **fake DEMO data** on the development system.

**Start the app:** run `npm run dev`, then open http://localhost:3000/login.
**Passwords:** see `dev-accounts.local.txt` (run `npm run seed:dev-accounts` for new ones).

**New here? Start with the guided System tour:** sign in as `demo.manager@example.com`, click **🧭 Tour** at the top right, then **Create sample data** and **Start the guided tour**. A floating guide takes you page by page through a sample client (DEMO Tour Sample Co.) whose records went all the way from client submission to a return ready to file, each step done by the right demo person. Some items are left for you to finish (post an invoice, review a purchase, confirm a filing). Sign in as `demo.owner`, `demo.accountant` and `demo.reviewer` and take the tour again to see each side. Needs SQL 0036 to 0045 and `npm run seed:dev-accounts` (adds the demo reviewer).

Tick each box as you go. If something does not match, write down what you saw.

---

## A. Bookkeeping: sign in as `demo.accountant@example.com` (authenticator already set up)

1. ☐ You land on **My clients**. Only **DEMO Sampaguita Trading** is listed (the accountant is assigned to that one client only).
2. ☐ Click it. You see tabs: **Overview · Intake · Imports · Journal · Trial balance · General ledger · Chart of accounts · Periods**.
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

## D. Client sends records (Phase 6): sign in as `demo.owner@example.com`

19. ☐ The **Overview** shows cards (Drafts, With the firm, Approved or posted, Documents) and buttons to record, upload and import.
20. ☐ **Transactions → + New transaction.** Choose **Sale**, enter only a total, click **Save and submit for review**. ☐ It is refused: "Required for sales and purchases" appears under the invoice number. Nothing is saved.
21. ☐ Fill in an invoice number, a customer name and a total, then **double-click** "Save and submit for review". ☐ You land on the transaction with status **Submitted**. ☐ The Transactions list shows it **once**.
22. ☐ Record the **same invoice number for the same customer** again. ☐ It is refused as a **duplicate**.
23. ☐ **Documents:** upload a PDF or a phone photo. ☐ It shows "✓ Uploaded" and can be downloaded. Upload the same file again. ☐ It is refused ("already uploaded"). Rename a non-document file (e.g. a .exe) to .pdf and upload it. ☐ It is refused.
24. ☐ **Imports:** upload `tests/fixtures/synthetic-books.xlsx`. Choose **Purchase** as the type and click **Check all rows**. ☐ Rows 5–7 are **Ready** and row 9 (TOTAL) is an **Error**, with the Excel row numbers. Click **Import 3 ready rows**. ☐ The summary says 3 imported.
25. ☐ **Customers & suppliers:** add a supplier with a TIN. ☐ Adding another supplier with the same TIN is refused.
26. ☐ **Business profile:** fill in the form and **Save and submit**. ☐ The status shows **Submitted**.

## E. Firm reviews (Phase 6): `demo.accountant`, then `demo.manager`

27. ☐ As the accountant, open **DEMO Sampaguita Trading → Intake**. The submitted transactions are listed. Open one and click **Mark as reviewed**. ☐ There is **no Approve button**; it says another reviewer must approve.
28. ☐ Open another one, expand **Return to the client for correction**, write a comment and send it. ☐ As demo.owner, the overview now says "need your correction" and the comment is shown on the transaction.
29. ☐ As the manager, open the reviewed transaction and click **Approve**. ☐ The status is **Approved**. Then, as the **accountant**, open it again: a **Book in the journal** form appears, already filled with the amount, supplier and receipt number. Choose the accounts, create the draft and submit it. As the **manager**, approve and post that journal entry. ☐ The transaction now shows **Posted**.
30. ☐ The **Review queue** also lists client submissions waiting for review or approval.

---

## For the accounting firm's CPA (the review that matters)

Please check and sign:
- **[accounting/TEST-SCENARIOS.md](accounting/TEST-SCENARIOS.md):** are the sample entries and expected results correct? Do you agree with the policy choices (corrections, numbering, who can approve)?
- **[accounting/COA-TEMPLATE-PROPOSED.md](accounting/COA-TEMPLATE-PROPOSED.md):** is this chart of accounts acceptable, or what should change?

**Not built yet (so don't look for it):** VAT/withholding computation and tax tagging, purchase/sales registers, payroll computation, financial statements, BIR forms, requests for information, email notifications, and a client-side view of the books.
