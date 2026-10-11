export const RULE_KIND_LABEL: Record<string, string> = {
  sss: "SSS",
  philhealth: "PhilHealth",
  pagibig: "Pag-IBIG",
  withholding: "Withholding tax on compensation",
};

export const RULE_METHOD_LABEL: Record<string, string> = {
  fixed_table: "Fixed amounts per bracket",
  rate_table: "Rates per bracket (floor/ceiling)",
  graduated: "Graduated tax table",
};

export const PAYMENT_KIND_LABEL: Record<string, string> = {
  net_pay: "Net pay to employees",
  sss: "SSS remittance",
  philhealth: "PhilHealth remittance",
  pagibig: "Pag-IBIG remittance",
  withholding: "Withholding tax remittance",
  deduction: "Other deduction remittance",
};

export const ACCESS_LABEL: Record<string, string> = {
  view: "View",
  prepare: "Prepare",
  approve: "Approve",
};
