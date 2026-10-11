export type MovementType =
  "receipt" | "issue" | "customer_return" | "supplier_return" | "transfer" | "adjustment";

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  receipt: "Stock receipt",
  issue: "Issue / sale",
  customer_return: "Customer return",
  supplier_return: "Return to supplier",
  transfer: "Transfer between locations",
  adjustment: "Count adjustment",
};

export const MOVEMENT_HELP: Record<MovementType, string> = {
  receipt:
    "Goods on a posted purchase bill are received at the bill's cost and create no journal entry (the bill already booked them). Without a bill, enter the unit cost and the account to credit (e.g. opening balances).",
  issue:
    "Issued at the moving average cost: Dr Cost of goods sold / Cr Inventory. Link the posted sales invoice so the quantity cannot exceed what was invoiced.",
  customer_return:
    "Returned at the cost the goods were issued at for that invoice line: Dr Inventory / Cr Cost of goods sold.",
  supplier_return:
    "Returned at the moving average cost: Dr the charge account (default: advances to suppliers) / Cr Inventory.",
  transfer: "Moves quantity and its average value between locations. No journal entry.",
  adjustment:
    "Enter the count difference (negative for a shortage). Shortages leave at average cost; surpluses at the unit cost given (or the last cost).",
};
