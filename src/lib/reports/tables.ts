/**
 * Uniform report tables (screen and CSV) built from the statements, with an
 * optional comparison column and the change between the two.
 */
import type { BalanceSheet, Block, CashFlow, IncomeStatement, TrialBalance } from "./statements";

export interface ReportRow {
  kind: "heading" | "line" | "subtotal" | "total" | "check";
  label: string;
  values: (bigint | null)[];
  accountId?: string;
}
export interface ReportTable {
  columns: string[];
  rows: ReportRow[];
}

type Pair<T> = { current: T; prior?: T };

/** Lines of a block, aligned across current and prior by key (union, current order first). */
function blockRows(b: Pair<Block>): ReportRow[] {
  const keys: { key: string; label: string; accountId?: string }[] = [];
  const seen = new Set<string>();
  for (const l of [...b.current.lines, ...(b.prior?.lines ?? [])]) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    keys.push({ key: l.key, label: l.label, accountId: l.accountId });
  }
  const find = (blk: Block | undefined, key: string) =>
    blk ? (blk.lines.find((l) => l.key === key)?.amount ?? 0n) : null;
  return keys.map((k) => ({
    kind: "line" as const,
    label: k.label,
    accountId: k.accountId,
    values: withChange(find(b.current, k.key)!, b.prior ? find(b.prior, k.key) : undefined),
  }));
}
function withChange(current: bigint, prior: bigint | null | undefined): (bigint | null)[] {
  return prior === undefined
    ? [current]
    : [current, prior, prior === null ? null : current - prior];
}
const value = <T>(p: Pair<T>, f: (t: T) => bigint) =>
  withChange(f(p.current), p.prior == null ? undefined : f(p.prior));
const columns = (label: string, priorLabel?: string) =>
  priorLabel ? [label, priorLabel, "Change"] : [label];

function section(p: Pair<Block>, totalLabel?: string): ReportRow[] {
  if (p.current.lines.length === 0 && (p.prior?.lines.length ?? 0) === 0) return [];
  return [
    { kind: "heading", label: p.current.title, values: [] },
    ...blockRows(p),
    {
      kind: "subtotal",
      label: totalLabel ?? `Total ${p.current.title.toLowerCase()}`,
      values: value(p, (b) => b.total),
    },
  ];
}
const pick = <T, K extends keyof T>(p: Pair<T>, k: K): Pair<T[K]> => ({
  current: p.current[k],
  prior: p.prior == null ? undefined : p.prior[k],
});

export function incomeStatementTable(
  p: Pair<IncomeStatement>,
  label: string,
  priorLabel?: string,
): ReportTable {
  return {
    columns: columns(label, priorLabel),
    rows: [
      ...section(pick(p, "revenue")),
      ...section(pick(p, "costOfSales")),
      { kind: "total", label: "Gross profit", values: value(p, (s) => s.grossProfit) },
      ...section(pick(p, "operatingExpenses")),
      { kind: "total", label: "Operating profit", values: value(p, (s) => s.operatingProfit) },
      ...section(pick(p, "otherIncome")),
      ...section(pick(p, "otherExpenses")),
      {
        kind: "total",
        label: "Profit before income tax",
        values: value(p, (s) => s.profitBeforeTax),
      },
      ...section(pick(p, "incomeTax")),
      { kind: "total", label: "Net profit (loss)", values: value(p, (s) => s.netProfit) },
    ],
  };
}

export function balanceSheetTable(
  p: Pair<BalanceSheet>,
  label: string,
  priorLabel?: string,
): ReportTable {
  return {
    columns: columns(label, priorLabel),
    rows: [
      ...section(pick(p, "currentAssets")),
      ...section(pick(p, "noncurrentAssets")),
      { kind: "total", label: "TOTAL ASSETS", values: value(p, (s) => s.totalAssets) },
      ...section(pick(p, "currentLiabilities")),
      ...section(pick(p, "noncurrentLiabilities")),
      { kind: "subtotal", label: "Total liabilities", values: value(p, (s) => s.totalLiabilities) },
      ...section(pick(p, "equity")),
      {
        kind: "total",
        label: "TOTAL LIABILITIES AND EQUITY",
        values: value(p, (s) => s.totalLiabilitiesAndEquity),
      },
    ],
  };
}

export function cashFlowTable(p: Pair<CashFlow>, label: string, priorLabel?: string): ReportTable {
  return {
    columns: columns(label, priorLabel),
    rows: [
      { kind: "heading", label: "Operating activities", values: [] },
      { kind: "line", label: "Profit for the period", values: value(p, (c) => c.profit) },
      ...blockRows(pick(p, "noncash")),
      ...blockRows(pick(p, "workingCapital")),
      {
        kind: "subtotal",
        label: "Net cash from operating activities",
        values: value(p, (c) => c.operating),
      },
      ...section(pick(p, "investing"), "Net cash from investing activities"),
      ...section(pick(p, "financing"), "Net cash from financing activities"),
      { kind: "total", label: "Net change in cash", values: value(p, (c) => c.netChange) },
      {
        kind: "line",
        label: "Cash at the beginning of the period",
        values: value(p, (c) => c.openingCash),
      },
      {
        kind: "total",
        label: "Cash at the end of the period",
        values: value(p, (c) => c.closingCash),
      },
    ],
  };
}

export function trialBalanceTable(tb: TrialBalance): ReportTable {
  return {
    columns: ["Opening (Dr − Cr)", "Debits", "Credits", "Closing (Dr − Cr)"],
    rows: [
      ...tb.rows.map((r) => ({
        kind: "line" as const,
        label: `${r.code} ${r.name}`,
        accountId: r.account_id,
        values: [r.opening, r.debit, r.credit, r.closing],
      })),
      {
        kind: "total" as const,
        label: "Totals",
        values: [tb.totals.opening, tb.totals.debit, tb.totals.credit, tb.totals.closing],
      },
    ],
  };
}
