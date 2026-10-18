/**
 * Financial statements built from posted account balances
 * (public.report_account_balances). Pure functions, exact integer centavos
 * (BigInt), no floating point. Policies: docs/reports/ACCOUNTING-POLICIES.md
 * (PROPOSED, PENDING CPA REVIEW).
 *
 * Accounting profit shown here is NOT taxable income and is never used to
 * compute a tax liability.
 */

export type Section =
  | "cash"
  | "current_asset"
  | "noncurrent_asset"
  | "current_liability"
  | "noncurrent_liability"
  | "equity"
  | "revenue"
  | "other_income"
  | "cost_of_sales"
  | "operating_expense"
  | "other_expense"
  | "income_tax";
export type CashFlowClass = "cash" | "operating" | "investing" | "financing" | "noncash";

export interface BalanceRow {
  account_id: string;
  code: string;
  name: string;
  account_type: "asset" | "liability" | "equity" | "revenue" | "expense";
  normal_balance: "debit" | "credit";
  section: Section;
  cash_flow_class: CashFlowClass | null;
  mapping_is_default: boolean;
  /** debit minus credit before the period */
  opening_net: string;
  period_debit: string;
  period_credit: string;
  /** debit minus credit at the end of the period */
  closing_net: string;
}

/** Signed decimal text -> centavos. */
export function cents(value: string): bigint {
  const v = value.trim();
  if (!/^-?\d{1,16}(\.\d{1,2})?$/.test(v)) throw new Error(`invalid amount: ${value}`);
  const negative = v.startsWith("-");
  const [whole, frac = ""] = (negative ? v.slice(1) : v).split(".");
  const c = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
  return negative ? -c : c;
}
export function toText(c: bigint): string {
  const negative = c < 0n;
  const abs = negative ? -c : c;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export interface Line {
  key: string;
  label: string;
  amount: bigint;
  /** drill-down target */
  accountId?: string;
  code?: string;
}
export interface Block {
  key: string;
  title: string;
  lines: Line[];
  total: bigint;
}
const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);
const block = (key: string, title: string, lines: Line[]): Block => ({
  key,
  title,
  lines,
  total: sum(lines.map((l) => l.amount)),
});
const accountLine = (r: BalanceRow, amount: bigint): Line => ({
  key: r.account_id,
  label: `${r.code} ${r.name}`,
  amount,
  accountId: r.account_id,
  code: r.code,
});
const movement = (r: BalanceRow) => cents(r.period_debit) - cents(r.period_credit);
const PNL: Section[] = [
  "revenue",
  "other_income",
  "cost_of_sales",
  "operating_expense",
  "other_expense",
  "income_tax",
];
const isPnl = (r: BalanceRow) => PNL.includes(r.section);

// ---------------------------------------------------------------------------
// Trial balance with period movements
// ---------------------------------------------------------------------------
export interface TrialBalance {
  rows: (BalanceRow & { opening: bigint; debit: bigint; credit: bigint; closing: bigint })[];
  totals: { opening: bigint; debit: bigint; credit: bigint; closing: bigint };
  /** opening and closing nets sum to zero; period debits equal credits */
  balanced: boolean;
}
export function trialBalance(rows: readonly BalanceRow[], includeZero = false): TrialBalance {
  const out = rows
    .map((r) => ({
      ...r,
      opening: cents(r.opening_net),
      debit: cents(r.period_debit),
      credit: cents(r.period_credit),
      closing: cents(r.closing_net),
    }))
    .filter((r) => includeZero || r.opening !== 0n || r.debit !== 0n || r.credit !== 0n);
  const totals = {
    opening: sum(out.map((r) => r.opening)),
    debit: sum(out.map((r) => r.debit)),
    credit: sum(out.map((r) => r.credit)),
    closing: sum(out.map((r) => r.closing)),
  };
  return {
    rows: out,
    totals,
    balanced: totals.opening === 0n && totals.closing === 0n && totals.debit === totals.credit,
  };
}

// ---------------------------------------------------------------------------
// Income statement (period movements; closing entries excluded by the caller)
// ---------------------------------------------------------------------------
export interface IncomeStatement {
  revenue: Block;
  costOfSales: Block;
  grossProfit: bigint;
  operatingExpenses: Block;
  operatingProfit: bigint;
  otherIncome: Block;
  otherExpenses: Block;
  profitBeforeTax: bigint;
  incomeTax: Block;
  netProfit: bigint;
}
export function incomeStatement(rows: readonly BalanceRow[]): IncomeStatement {
  const credit = (s: Section) =>
    rows
      .filter((r) => r.section === s && movement(r) !== 0n)
      .map((r) => accountLine(r, -movement(r)));
  const debit = (s: Section) =>
    rows
      .filter((r) => r.section === s && movement(r) !== 0n)
      .map((r) => accountLine(r, movement(r)));
  const revenue = block("revenue", "Revenue", credit("revenue"));
  const costOfSales = block("cost_of_sales", "Cost of sales", debit("cost_of_sales"));
  const operatingExpenses = block(
    "operating_expense",
    "Operating expenses",
    debit("operating_expense"),
  );
  const otherIncome = block("other_income", "Other income", credit("other_income"));
  const otherExpenses = block("other_expense", "Other expenses", debit("other_expense"));
  const incomeTax = block("income_tax", "Income tax expense (as recorded)", debit("income_tax"));
  const grossProfit = revenue.total - costOfSales.total;
  const operatingProfit = grossProfit - operatingExpenses.total;
  const profitBeforeTax = operatingProfit + otherIncome.total - otherExpenses.total;
  return {
    revenue,
    costOfSales,
    grossProfit,
    operatingExpenses,
    operatingProfit,
    otherIncome,
    otherExpenses,
    profitBeforeTax,
    incomeTax,
    netProfit: profitBeforeTax - incomeTax.total,
  };
}

// ---------------------------------------------------------------------------
// Balance sheet (as of; rows fetched from the fiscal-year start so profit not
// yet closed can be split between prior years and the current year)
// ---------------------------------------------------------------------------
export interface BalanceSheet {
  currentAssets: Block;
  noncurrentAssets: Block;
  totalAssets: bigint;
  currentLiabilities: Block;
  noncurrentLiabilities: Block;
  totalLiabilities: bigint;
  equity: Block;
  totalEquity: bigint;
  totalLiabilitiesAndEquity: bigint;
  balanced: boolean;
}
export function balanceSheet(rows: readonly BalanceRow[]): BalanceSheet {
  const debitSide = (ss: Section[]) =>
    rows
      .filter((r) => ss.includes(r.section) && cents(r.closing_net) !== 0n)
      .map((r) => accountLine(r, cents(r.closing_net)));
  const creditSide = (ss: Section[]) =>
    rows
      .filter((r) => ss.includes(r.section) && cents(r.closing_net) !== 0n)
      .map((r) => accountLine(r, -cents(r.closing_net)));
  const pnl = rows.filter(isPnl);
  const priorProfit = -sum(pnl.map((r) => cents(r.opening_net)));
  const currentProfit = -sum(pnl.map((r) => cents(r.closing_net) - cents(r.opening_net)));
  const currentAssets = block(
    "current_assets",
    "Current assets",
    debitSide(["cash", "current_asset"]),
  );
  const noncurrentAssets = block(
    "noncurrent_assets",
    "Non-current assets",
    debitSide(["noncurrent_asset"]),
  );
  const currentLiabilities = block(
    "current_liabilities",
    "Current liabilities",
    creditSide(["current_liability"]),
  );
  const noncurrentLiabilities = block(
    "noncurrent_liabilities",
    "Non-current liabilities",
    creditSide(["noncurrent_liability"]),
  );
  const equityLines = creditSide(["equity"]);
  if (priorProfit !== 0n)
    equityLines.push({
      key: "prior_profit",
      label: "Profit of prior years not yet closed",
      amount: priorProfit,
    });
  if (currentProfit !== 0n || equityLines.length === 0)
    equityLines.push({
      key: "current_profit",
      label: "Profit for the current year to date",
      amount: currentProfit,
    });
  const equity = block("equity", "Equity", equityLines);
  const totalAssets = currentAssets.total + noncurrentAssets.total;
  const totalLiabilities = currentLiabilities.total + noncurrentLiabilities.total;
  return {
    currentAssets,
    noncurrentAssets,
    totalAssets,
    currentLiabilities,
    noncurrentLiabilities,
    totalLiabilities,
    equity,
    totalEquity: equity.total,
    totalLiabilitiesAndEquity: totalLiabilities + equity.total,
    balanced: totalAssets === totalLiabilities + equity.total,
  };
}

// ---------------------------------------------------------------------------
// Cash flow statement, indirect method (period movements, closing excluded)
// ---------------------------------------------------------------------------
export interface CashFlow {
  profit: bigint;
  noncash: Block;
  workingCapital: Block;
  operating: bigint;
  investing: Block;
  financing: Block;
  netChange: bigint;
  openingCash: bigint;
  closingCash: bigint;
  /** opening cash + net change = closing cash */
  reconciles: boolean;
}
export function cashFlow(rows: readonly BalanceRow[]): CashFlow {
  // A balance-sheet account's cash effect is the opposite of its debit movement.
  const effect = (c: CashFlowClass) =>
    rows
      .filter((r) => !isPnl(r) && r.cash_flow_class === c && movement(r) !== 0n)
      .map((r) => accountLine(r, -movement(r)));
  const profit = -sum(rows.filter(isPnl).map(movement));
  const noncash = block("noncash", "Non-cash items", effect("noncash"));
  const workingCapital = block(
    "working_capital",
    "Changes in working capital",
    effect("operating"),
  );
  const investing = block("investing", "Investing activities", effect("investing"));
  const financing = block("financing", "Financing activities", effect("financing"));
  const operating = profit + noncash.total + workingCapital.total;
  const netChange = operating + investing.total + financing.total;
  const cashRows = rows.filter((r) => r.cash_flow_class === "cash");
  const openingCash = sum(cashRows.map((r) => cents(r.opening_net)));
  const closingCash = sum(cashRows.map((r) => cents(r.closing_net)));
  return {
    profit,
    noncash,
    workingCapital,
    operating,
    investing,
    financing,
    netChange,
    openingCash,
    closingCash,
    reconciles: openingCash + netChange === closingCash,
  };
}

// ---------------------------------------------------------------------------
// Presentation rounding (whole pesos)
// ---------------------------------------------------------------------------
/** Rounds centavos to whole pesos (in centavos), half away from zero. */
export function roundPeso(c: bigint): bigint {
  const negative = c < 0n;
  const abs = negative ? -c : c;
  const r = ((abs + 50n) / 100n) * 100n;
  return negative ? -r : r;
}
/**
 * Rounds each line to whole pesos. If the rounded lines no longer add up to
 * the rounded exact total, a "Rounding difference" line makes them agree, so
 * printed totals always equal the exact totals rounded.
 */
export function roundBlock(b: Block): Block {
  const lines = b.lines.map((l) => ({ ...l, amount: roundPeso(l.amount) }));
  const target = roundPeso(b.total);
  const diff = target - sum(lines.map((l) => l.amount));
  if (diff !== 0n)
    lines.push({ key: `${b.key}_rounding`, label: "Rounding difference", amount: diff });
  return { ...b, lines, total: target };
}

/** Income statement in whole pesos: blocks rounded, subtotals from the rounded blocks. */
export function roundIncomeStatement(s: IncomeStatement): IncomeStatement {
  const r = {
    revenue: roundBlock(s.revenue),
    costOfSales: roundBlock(s.costOfSales),
    operatingExpenses: roundBlock(s.operatingExpenses),
    otherIncome: roundBlock(s.otherIncome),
    otherExpenses: roundBlock(s.otherExpenses),
    incomeTax: roundBlock(s.incomeTax),
  };
  const grossProfit = r.revenue.total - r.costOfSales.total;
  const operatingProfit = grossProfit - r.operatingExpenses.total;
  const profitBeforeTax = operatingProfit + r.otherIncome.total - r.otherExpenses.total;
  return {
    ...r,
    grossProfit,
    operatingProfit,
    profitBeforeTax,
    netProfit: profitBeforeTax - r.incomeTax.total,
  };
}

/** Balance sheet in whole pesos; any peso difference is shown in equity so it still balances. */
export function roundBalanceSheet(s: BalanceSheet): BalanceSheet {
  const currentAssets = roundBlock(s.currentAssets);
  const noncurrentAssets = roundBlock(s.noncurrentAssets);
  const currentLiabilities = roundBlock(s.currentLiabilities);
  const noncurrentLiabilities = roundBlock(s.noncurrentLiabilities);
  let equity = roundBlock(s.equity);
  const totalAssets = currentAssets.total + noncurrentAssets.total;
  const totalLiabilities = currentLiabilities.total + noncurrentLiabilities.total;
  const diff = totalAssets - totalLiabilities - equity.total;
  if (diff !== 0n && s.balanced) {
    equity = {
      ...equity,
      lines: [...equity.lines, { key: "bs_rounding", label: "Rounding difference", amount: diff }],
      total: equity.total + diff,
    };
  }
  return {
    currentAssets,
    noncurrentAssets,
    totalAssets,
    currentLiabilities,
    noncurrentLiabilities,
    totalLiabilities,
    equity,
    totalEquity: equity.total,
    totalLiabilitiesAndEquity: totalLiabilities + equity.total,
    balanced: totalAssets === totalLiabilities + equity.total,
  };
}

/**
 * Cash flow in whole pesos: blocks rounded; opening and closing cash rounded;
 * any peso difference is shown in working capital so the statement still
 * reconciles.
 */
export function roundCashFlow(c: CashFlow): CashFlow {
  const noncash = roundBlock(c.noncash);
  let workingCapital = roundBlock(c.workingCapital);
  const investing = roundBlock(c.investing);
  const financing = roundBlock(c.financing);
  const profit = roundPeso(c.profit);
  const openingCash = roundPeso(c.openingCash);
  const closingCash = roundPeso(c.closingCash);
  const diff =
    closingCash -
    openingCash -
    (profit + noncash.total + workingCapital.total + investing.total + financing.total);
  if (diff !== 0n && c.reconciles) {
    workingCapital = {
      ...workingCapital,
      lines: [
        ...workingCapital.lines,
        { key: "cf_rounding", label: "Rounding difference", amount: diff },
      ],
      total: workingCapital.total + diff,
    };
  }
  const operating = profit + noncash.total + workingCapital.total;
  const netChange = operating + investing.total + financing.total;
  return {
    profit,
    noncash,
    workingCapital,
    operating,
    investing,
    financing,
    netChange,
    openingCash,
    closingCash,
    reconciles: openingCash + netChange === closingCash,
  };
}
