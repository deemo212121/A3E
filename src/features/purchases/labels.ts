/** Wording for the amount a bill leaves to pay. */
export function savePurchaseBillLabel(billType: string): string {
  return billType === "cash_purchase" ? "paid" : "to pay";
}
