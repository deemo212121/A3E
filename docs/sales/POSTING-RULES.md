# Sales and Receivables: Posting Rules (Phase 7)

**Status:** implemented 2026-10-10, **pending CPA review**. The platform **records** invoices the client issued elsewhere. It does not issue invoices or e-invoices, and it does not transmit anything to the BIR (decision D-01; research in [doc 10](../10-electronic-invoicing-research.md)). The VAT rate comes from the `tax_rates` table and is **pending CPA sign-off**; each document stores the rate and its status at the time.

## 1. Amounts (computed by the database)

For each line:
1. **Line amount** = round(quantity × unit price, 2) − discount. It must be more than 0.
2. **VATable lines, prices exclude VAT:** VAT = round(line amount × rate, 2); net = line amount.
3. **VATable lines, prices include VAT:** VAT = round(line amount × rate ÷ (1 + rate), 2); net = line amount − VAT.
4. **Zero-rated, exempt, or no-VAT lines** (the seller isn't VAT-registered): VAT = 0; net = line amount.

Rounding is done **per line**, to the centavo, half away from zero.
- Invoice VAT = the sum of line VATs.
- Amount due = the sum of (net + VAT).
- The invoice totals by class (VATable, zero-rated, exempt, no-VAT sales) come from the lines.

❓ **CPA:** confirm per-line rounding (instead of rounding once on the invoice total), and the treatment of discounts (deducted per line before VAT).

## 2. Journal entries

| Document | Debit | Credit |
|---|---|---|
| **Sales invoice** (posted) | Accounts receivable = amount due | Revenue (line account, else Sales) = net, by account. Output VAT = VAT. |
| **Credit note** (return, price adjustment, discount, correction) | Sales returns and allowances = net. Output VAT = VAT. | Accounts receivable = total |
| **Customer receipt** | Cash/bank = amount received. Creditable withholding tax = tax withheld (as stated on the customer's certificate). | Accounts receivable = amount applied to invoices. Advances from customers = the unapplied rest. |
| **Cancellation of a posted document** | A **reversing entry** (the original stays; nothing is deleted) | |

**Accounts.** They are set per client under *Sales → Posting accounts*. The starter defaults are:
- 1100 Accounts Receivable
- 4010 Sales
- 2100 Output Tax
- 4030 Sales Returns and Allowances
- 1320 Creditable Withholding Tax
- 2040 Advances from Customers (new)

❓ **CPA:**
- Is "Sales returns and allowances" right for price adjustments and discounts given after the sale, or do you want separate accounts?
- Should overpayments go to a customer-advance liability?

## 3. Controls

- **Maker-checker:** an assigned preparer records and submits; a **different** reviewer or manager posts. Posting is the approval.
- **Duplicates:** these are refused while the existing record is live:
  - the same invoice number in the client's series
  - the same credit note number
  - the same receipt number
  - an intake transaction already recorded as an invoice

  Every create also has a request key, so a retry returns the same record. Posting twice returns the same journal entry.
- **No over-payment and no over-crediting:** at posting, the invoices are locked and balances re-checked. Two receipts posted at the same time cannot over-apply one invoice. A credit note can never exceed the invoice's balance.
- **Controlled cancellation:**
  - Drafts can be cancelled by the preparer.
  - Posted documents can be cancelled only by a reviewer or manager, with a reason, by a reversing entry.
  - An invoice with posted receipts or credit notes must have those cancelled first.
  - The cancellation date can't be earlier than the last related posting. This keeps the subledger and the ledger in agreement for every date.
- **Corrections:** correct a draft directly, or return it for correction. Fix a posted invoice with a credit note, or by cancelling it and recording it again; the number becomes free after cancellation.
- **Immutability:** posted documents and their lines can't be changed, even by direct SQL as the table owner. Only the workflow columns change.
- **Audit:** every change is logged in `audit.events`, and the status history is in `intake_events`.
- **Intake link:** an approved client *sale* can be recorded as an invoice. It is then marked posted when the invoice posts, and it can't **also** be booked through a journal entry (and the other way round).

## 4. Balances and reconciliation

- **Outstanding** = invoice total − posted credit notes − posted receipt allocations. It can be calculated "as of" any date, using the dates of the journal entries.
- **Aging buckets:** not due, 1–30, 31–60, 61–90, and over 90 days past the due date.
- **Reconciliation:** the sum of open invoice balances is compared with the general-ledger balance of the receivables account. A difference means something was posted to receivables outside the sales module, for example a manual journal entry.
- **Statement of account:** a printable list of open invoices for one customer, labelled "not an invoice or official receipt".
