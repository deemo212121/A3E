import { describe, expect, it } from "vitest";

import { sourceLink } from "./source-link";

const C = "aaaaaaaa-0000-4000-8000-00000000000a";
const ID = "bbbbbbbb-0000-4000-8000-00000000000b";

describe("drill-down from a journal entry to its source document", () => {
  it("links known sources, refuses malformed references, labels manual entries", () => {
    expect(sourceLink(C, "sales_invoice", ID)).toEqual({
      label: "Sales invoice",
      href: `/staff/clients/${C}/sales/invoices/${ID}`,
    });
    expect(sourceLink(C, "reversal", ID)?.href).toBe(`/staff/clients/${C}/journal/${ID}`);
    expect(sourceLink(C, "payroll_run", ID)?.href).toBe(`/staff/clients/${C}/payroll/runs/${ID}`);
    expect(sourceLink(C, "purchase_bill", "not-a-uuid")).toBeNull();
    expect(sourceLink(C, null, null)).toBeNull();
    expect(sourceLink(C, "bank_import", "x")).toEqual({ label: "bank import", href: "" });
  });
});
