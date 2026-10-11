# Inventory and Cost of Goods Sold: Costing Method and Posting Rules (Phase 9)

**Status:** implemented 2026-10-10. **PROPOSED: PENDING VERIFICATION** by the firm's CPA. The values are computed by the database. They are **not yet validated** for financial statements or tax.

## 1. Costing method (proposed)

The proposed method is **moving weighted average, perpetual**. Every stock movement updates the item's quantity and value immediately.

- **Average cost** = value on hand ÷ quantity on hand (company-wide, across all locations).
- **Goods out** (issues, supplier returns, count shortages, transfers out) leave at the average: value = round(value on hand × qty ÷ qty on hand, 2). When the **last unit** leaves, it takes the exact remaining value, so no rounding residue stays in stock.
- **Goods in** are valued at their actual cost (the bill, or the cost entered) and raise or lower the average.
- **Alternative:** FIFO. Not built. If the CPA prefers FIFO, the stock ledger already holds every receipt with its cost, so it can be added as a per-client option.
- **Questions for the CPA (❓):**
  - Is moving average acceptable for each client?
  - Should the average be per location instead of company-wide?
  - What is the rounding policy (currently centavo per movement line)?

The method is stored per client as `costing_method = weighted_average` with `costing_status = pending_verification`. Nothing in the system marks it verified yet.

## 2. Source of truth

The **stock ledger** (`inventory_ledger`) is append-only:
- One row for each quantity and value change, per item and location.
- Each row is linked to its movement and, where applicable, to the bill line or invoice line.
- Balances on items and locations are kept from it under row locks. `inventory_quantity_check` proves that they agree.

## 3. Journal entries (no duplicates)

| Movement | Stock value | Journal entry |
|---|---|---|
| **Receipt from a posted purchase bill** | The bill line's net cost, in proportion to the quantity received (the final receipt takes the remainder) | **None.** The bill already debited Inventory. |
| **Receipt without a bill** (opening stock, other source) | qty × unit cost entered | Dr Inventory / Cr the account chosen (e.g. equity for opening balances) |
| **Issue** (sale, sample, own use) | qty × average | Dr Cost of goods sold / Cr Inventory. **Revenue comes only from the sales invoice.** |
| **Customer return** (must refer to the invoice) | The cost at which that invoice line was issued, in proportion | Dr Inventory / Cr Cost of goods sold |
| **Return to supplier** | qty × average | Dr the charge account (default 1130 Advances to suppliers, i.e. a claim on the supplier) / Cr Inventory |
| **Transfer between locations** | The average value moves with the quantity | **None** (company value unchanged) |
| **Count adjustment: shortage** | qty × average | Dr the count-differences account (default 6900) / Cr Inventory |
| **Count adjustment: surplus** | qty × unit cost entered (or the last cost) | Dr Inventory / Cr the count-differences account |
| **Cancellation** | Reverses the exact stock-ledger rows | A **reversing entry** on the movement's date. Nothing is deleted. |

**Entries:**
- There is one balanced entry per movement, netted per account.
- Entries are prepared by the movement's preparer and **posted by a different reviewer or manager**.

**Default accounts:**
- 5010 Cost of goods sold
- 6900 Miscellaneous expense (count differences)
- 1130 Advances to suppliers

**❓ For the CPA:**
- Should count differences go to a dedicated account?
- Should supplier returns be a debit memo against payables? The current default is advances.

## 4. Links to bills and invoices

- **Bills:**
  - A bill line can be received only if it is **posted**, its category treatment is **inventory**, and its account is the **item's inventory account**.
  - Bills booked to **5020 Purchases** are a periodic-system expense and cannot be received into stock. For tracked items, use an inventory category on 1200 (or another asset account).
  - Quantities are limited: received ≤ billed per bill line.
- **Invoices:**
  - Issued ≤ invoiced per invoice line.
  - Returned ≤ issued − already returned.
- **Cancelling linked documents:** a posted bill or invoice with posted stock movements **cannot be cancelled** until those movements are cancelled.

## 5. Safety rules

- **Negative stock:**
  - Refused for any item or location, unless a reviewer or manager approves a policy with a written business reason. The approval is recorded in the history.
  - Under that policy, the quantity beyond what is on hand is costed at the last unit cost. ❓ CPA to confirm. A later receipt can leave a small value with zero quantity, which shows in valuation.
- **Backdating:**
  - A movement cannot be posted earlier than the item's latest movement date. With moving average, inserting a past movement would change the cost of every later one.
  - To correct history, cancel the later movements (newest first) and re-enter them.
- **Periods:** a movement in a period that is not **open** (soft-closed or locked) is refused, including movements that create no journal entry. Cancellations need the movement's period to be open.
- **Cancellation order:** only the latest movement of each item can be cancelled.
- **Workflow:** draft → submitted → posted (maker-checker). Saves and posts are idempotent, so retries never duplicate.

## 6. Reconciliation (the gate)

`inventory_reconciliation(client, as_of)`, for each inventory account:

> **stock value** (stock ledger) **+ goods billed but not yet received** (posted inventory bill lines − received value) **= general-ledger balance**

Any difference means something was posted to the inventory account outside these modules, for example a manual journal entry. The *Stock & valuation* tab shows it.
