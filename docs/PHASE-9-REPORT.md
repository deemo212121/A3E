# Phase 9 Report: Inventory and Cost of Goods Sold

**Date:** 2026-10-10
**Status:** Submitted for review. **The SQL has NOT been applied yet.** The owner runs it manually (§5).
**Gate:** *Magkakatugma ang stock quantities, inventory valuation, at ledger balances* (stock quantities, inventory valuation and ledger balances agree).
- **Met in offline tests (§2).**
- Live tests are pending the SQL.

## 1. What was built

| Requirement | Delivered |
|---|---|
| Item master, units of measure | Items: SKU, name, unit and inventory (asset) account. Items cannot be deleted, only deactivated. An item's account is fixed once it has stock history. |
| Warehouses / locations | Locations with codes. Quantities are tracked per item and location. |
| Receipts, issues, returns, transfers, adjustments | Six movement types: receipt, issue/sale, customer return, return to supplier, transfer and count adjustment. Workflow: draft → submitted → posted, with maker-checker. |
| Movement history | Append-only **stock ledger**, a movement detail page (lines, computed ledger rows, linked entry) and a timeline |
| Costing method, proposed and documented | **Moving weighted average (perpetual): PENDING VERIFICATION.** See [inventory/COSTING-METHOD.md](inventory/COSTING-METHOD.md). FIFO is the documented alternative. |
| Linked to postings **without duplicate entries** | Bill receipts create **no** entry (the bill already debited inventory). Issues post **only COGS** (the invoice already posted revenue). Quantities are limited to what was billed or invoiced. Linked bills and invoices cannot be cancelled while stock movements are linked. |
| No negative stock without an approved policy | Refused per item and per location. A reviewer or manager may allow it with a written reason, and the approval is recorded. |
| Backdated transactions, closed periods | Posting before an item's latest movement is refused (it would rewrite later costs). Non-open periods are refused, even for movements with no journal entry. Cancellation is newest-first only. |

**Staff screens:** a new **Inventory** tab with five sections:
- Stock & valuation (as-of date, reconciliation, quantity by location)
- Movements
- Items
- Locations
- Accounts & policy

There is also a movement entry form and a movement detail page.

## 2. Tests actually run (offline, 2026-10-10)

| Suite | Result |
|---|---|
| `npm run check` (format, lint, typecheck, unit + DB tests, build, secret scan) | **Pass: 24 files, 377 tests** |
| `tests/db/inventory.test.ts` | **20/20**. Details below. |
| Mutation checks | Each of these makes tests fail: removing the negative-stock check, the over-receipt limit, the backdating check, the over-issue limit, or the newest-first cancellation rule |
| **Live database, page and browser tests** | **Not run.** They need the SQL applied first. |

What `tests/db/inventory.test.ts` covers:
- **Quantity reconciliation:** maintained balances equal the stock ledger, per item and per location.
- **Valuation:** a hand-worked walk-through of 9 movements (in the test file header), including proportional bill receipts (533.32 + 799.98 = 1,333.30) and a final issue that leaves exactly 0.00.
- **Returns:**
  - Customer returns come back at the issued cost and never exceed the quantity issued.
  - Supplier returns go out at average cost.
- **COGS:** issued at average cost, Dr 5010 / Cr 1200. The invoice's revenue is not duplicated.
- **GL reconciliation (the gate):** stock value + billed-not-received = inventory GL balance on 8 dates, and a manual entry shows up as a difference.
- **Duplicates and retries:** retried saves and posts don't double up. Over-receipt, a second receipt of a fully received bill line, and over-issue are all refused.
- **Policy, backdating and periods:** negative stock is blocked, then allowed by policy and blocked again. Backdating, soft-closed periods and cancellation order are all checked. Linked bills and invoices cannot be cancelled.
- **Isolation:** other clients see nothing. There are no direct writes, and the stock ledger cannot be deleted.

## 3. Assumptions (PENDING VERIFICATION)

- Moving average is calculated company-wide, not per location. Rounding is to the centavo per movement line.
- Supplier returns default to 1130 Advances to suppliers (a claim on the supplier), and count differences to 6900.
- Under an approved negative-stock policy, the shortfall is costed at the last unit cost.
- Inventory is valued at cost only. **Lower of cost and net realizable value (NRV) write-downs are not built.**

The ❓ questions for the CPA are listed in [COSTING-METHOD.md](inventory/COSTING-METHOD.md).

## 4. Open items

- **Not built:**
  - FIFO
  - NRV write-downs
  - editing a draft movement from the UI (save as new; cancel the old draft)
  - item editing in the UI (the API supports it)
  - client-portal stock view
  - production/assembly (bill of materials)
- The default purchase category "Purchases for resale" posts to **5020 Purchases** (a periodic expense). Clients who track stock need an **inventory category on 1200**. See COSTING-METHOD §4.

## 5. SQL to run (Supabase → SQL Editor), in order, one file at a time

If you haven't yet, run the Phase 7 and 8 files first. Then:

1. `supabase/migrations/20261010190000_inventory_enums.sql`, on its own
2. `supabase/migrations/20261010190100_inventory_core.sql`
3. `supabase/migrations/20261010190200_inventory_functions.sql`
