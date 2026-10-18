import "server-only";

import { comparisonRange, type Comparison } from "@/lib/reports/periods";
import {
  balanceSheet,
  cashFlow,
  cents,
  incomeStatement,
  roundBalanceSheet,
  roundCashFlow,
  roundIncomeStatement,
  roundPeso,
  trialBalance,
  type BalanceRow,
} from "@/lib/reports/statements";
import {
  balanceSheetTable,
  cashFlowTable,
  incomeStatementTable,
  trialBalanceTable,
  type ReportRow,
  type ReportTable,
} from "@/lib/reports/tables";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

/*
 * Builds every report from POSTED data through the database read models
 * (RLS and the period-close rule apply). One builder serves the screens, the
 * client portal and the CSV export, so they always agree.
 */

export const REPORTS = {
  trial_balance: "Trial balance",
  income_statement: "Income statement",
  balance_sheet: "Balance sheet",
  cash_flow: "Cash flow statement",
  ar_aging: "Receivables aging",
  ap_aging: "Payables aging",
  reconciliation: "Reconciliation summary",
} as const;
export type ReportKey = keyof typeof REPORTS;
export const PORTAL_REPORTS: ReportKey[] = ["income_statement", "balance_sheet", "cash_flow"];

export interface ReportOptions {
  report: ReportKey;
  from: string;
  to: string;
  compare: Comparison;
  rounding: "centavo" | "peso";
  includeZero: boolean;
}
export interface BuiltReport {
  title: string;
  subtitle: string;
  table: ReportTable;
  /** drill-down range for account lines */
  drill: { from: string | null; to: string; closing: boolean };
  /** periods in range that are still open: figures are preliminary */
  openPeriods: number;
  checks: { label: string; ok: boolean }[];
  notes: string[];
}

type Sb = Awaited<ReturnType<typeof createSupabaseServerClient>>;
async function rpc<T>(sb: Sb, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw fromDbError(error, fn);
  return data as T;
}
const balances = (sb: Sb, clientId: string, from: string | null, to: string, closing: boolean) =>
  rpc<BalanceRow[]>(sb, "report_account_balances", {
    p_client_id: clientId,
    p_from: from,
    p_to: to,
    p_include_closing: closing,
  });

export async function fiscalYearStart(sb: Sb, clientId: string, date: string): Promise<string> {
  const { data } = await sb
    .from("fiscal_years")
    .select("start_date")
    .eq("client_id", clientId)
    .lte("start_date", date)
    .gte("end_date", date)
    .maybeSingle();
  return (data?.start_date as string | undefined) ?? `${date.slice(0, 4)}-01-01`;
}

export async function closedThrough(clientId: string): Promise<string | null> {
  const sb = await createSupabaseServerClient();
  return rpc<string | null>(sb, "report_closed_through", { p_client_id: clientId });
}

const ACCOUNTING_NOTE =
  "Accounting profit from posted entries. It is not taxable income and no tax liability is derived from it.";

export async function buildReport(clientId: string, o: ReportOptions): Promise<BuiltReport> {
  const sb = await createSupabaseServerClient();
  const prior = o.compare === "none" ? null : comparisonRange(o.from, o.to, o.compare);
  const peso = o.rounding === "peso";
  const label = (f: string | null, t: string) => (f ? `${f} – ${t}` : `As of ${t}`);
  const notes: string[] = [];
  if (peso)
    notes.push(
      "Rounded to whole pesos (half away from zero); any difference is shown as a rounding line.",
    );

  let table: ReportTable;
  const title = REPORTS[o.report];
  let subtitle = label(o.from, o.to);
  let drill: BuiltReport["drill"] = { from: o.from, to: o.to, closing: true };
  const checks: BuiltReport["checks"] = [];
  let rangeStart: string | null = o.from;

  switch (o.report) {
    case "trial_balance": {
      const tb = trialBalance(await balances(sb, clientId, o.from, o.to, true), o.includeZero);
      checks.push({
        label: "Debits equal credits; opening and closing balances net to zero",
        ok: tb.balanced,
      });
      table = trialBalanceTable(tb);
      if (peso)
        table.rows = table.rows.map((r) => ({
          ...r,
          values: r.values.map((v) => (v === null ? v : roundPeso(v))),
        }));
      break;
    }
    case "income_statement": {
      const cur = incomeStatement(await balances(sb, clientId, o.from, o.to, false));
      const prev = prior
        ? incomeStatement(await balances(sb, clientId, prior.from, prior.to, false))
        : undefined;
      table = incomeStatementTable(
        {
          current: peso ? roundIncomeStatement(cur) : cur,
          prior: prev && (peso ? roundIncomeStatement(prev) : prev),
        },
        label(o.from, o.to),
        prior ? label(prior.from, prior.to) : undefined,
      );
      drill = { from: o.from, to: o.to, closing: false };
      notes.push(
        ACCOUNTING_NOTE,
        "Year-end closing entries are excluded so each period shows its own result.",
      );
      break;
    }
    case "balance_sheet": {
      const fy = await fiscalYearStart(sb, clientId, o.to);
      const cur = balanceSheet(await balances(sb, clientId, fy, o.to, true));
      checks.push({ label: "Assets equal liabilities plus equity", ok: cur.balanced });
      let prev;
      if (prior) {
        const pfy = await fiscalYearStart(sb, clientId, prior.to);
        prev = balanceSheet(await balances(sb, clientId, pfy, prior.to, true));
        checks.push({ label: `Comparison (${prior.to}) balances`, ok: prev.balanced });
      }
      table = balanceSheetTable(
        {
          current: peso ? roundBalanceSheet(cur) : cur,
          prior: prev && (peso ? roundBalanceSheet(prev) : prev),
        },
        `As of ${o.to}`,
        prior ? `As of ${prior.to}` : undefined,
      );
      subtitle = `As of ${o.to}`;
      drill = { from: null, to: o.to, closing: true };
      rangeStart = null;
      break;
    }
    case "cash_flow": {
      const cur = cashFlow(await balances(sb, clientId, o.from, o.to, false));
      checks.push({ label: "Opening cash + net change = closing cash", ok: cur.reconciles });
      const prev = prior
        ? cashFlow(await balances(sb, clientId, prior.from, prior.to, false))
        : undefined;
      table = cashFlowTable(
        {
          current: peso ? roundCashFlow(cur) : cur,
          prior: prev && (peso ? roundCashFlow(prev) : prev),
        },
        label(o.from, o.to),
        prior ? label(prior.from, prior.to) : undefined,
      );
      drill = { from: o.from, to: o.to, closing: false };
      notes.push(
        "Indirect method: profit adjusted for non-cash items and changes in balance-sheet accounts, classified per account (PENDING CPA REVIEW). Non-cash transactions (e.g. equipment bought on a loan) appear in both investing and financing.",
      );
      break;
    }
    case "ar_aging":
    case "ap_aging": {
      const ar = o.report === "ar_aging";
      const rows = await rpc<Record<string, string>[]>(sb, ar ? "ar_aging" : "ap_aging", {
        p_client_id: clientId,
        p_as_of: o.to,
      });
      const cols = [
        "not_due",
        "days_1_30",
        "days_31_60",
        "days_61_90",
        "over_90",
        "total",
      ] as const;
      const lines: ReportRow[] = rows.map((r) => ({
        kind: "line",
        label: r[ar ? "customer_name" : "supplier_name"],
        values: cols.map((c) => cents(r[c])),
      }));
      table = {
        columns: ["Not due", "1–30 days", "31–60", "61–90", "Over 90", "Total"],
        rows: [
          ...lines,
          {
            kind: "total",
            label: "Total",
            values: cols.map((_, i) => lines.reduce((s, l) => s + (l.values[i] ?? 0n), 0n)),
          },
        ],
      };
      if (peso)
        table.rows = table.rows.map((r) => ({
          ...r,
          values: r.values.map((v) => (v === null ? v : roundPeso(v))),
        }));
      subtitle = `As of ${o.to}`;
      rangeStart = null;
      break;
    }
    case "reconciliation": {
      table = { columns: ["Subledger", "General ledger", "Difference"], rows: [] };
      const add = (label: string, sub: string, gl: string) => {
        const d = cents(gl) - cents(sub);
        table.rows.push({ kind: "line", label, values: [cents(sub), cents(gl), d] });
        checks.push({ label, ok: d === 0n });
      };
      const tb = trialBalance(await balances(sb, clientId, null, o.to, true));
      checks.push({ label: "Trial balance: debits equal credits", ok: tb.balanced });
      const tryRpc = async <T>(
        fn: string,
        args: Record<string, unknown>,
        apply: (rows: T[]) => void,
      ) => {
        try {
          apply(await rpc<T[]>(sb, fn, args));
        } catch {
          notes.push(`${fn} is not available (module not set up yet).`);
        }
      };
      const asOf = { p_client_id: clientId, p_as_of: o.to };
      await tryRpc<{ subledger_total: string; ledger_balance: string }>(
        "ar_reconciliation",
        asOf,
        (r) =>
          r[0] &&
          add("Accounts receivable (open invoices)", r[0].subledger_total, r[0].ledger_balance),
      );
      await tryRpc<{ subledger_total: string; ledger_balance: string }>(
        "ap_reconciliation",
        asOf,
        (r) =>
          r[0] && add("Accounts payable (open bills)", r[0].subledger_total, r[0].ledger_balance),
      );
      await tryRpc<{
        account_code: string;
        stock_value: string;
        billed_not_received: string;
        ledger_balance: string;
      }>("inventory_reconciliation", asOf, (rows) =>
        rows.forEach((r) =>
          add(
            `Inventory ${r.account_code} (stock + billed not received)`,
            cents(r.stock_value) + cents(r.billed_not_received) === 0n
              ? "0.00"
              : toText(cents(r.stock_value) + cents(r.billed_not_received)),
            r.ledger_balance,
          ),
        ),
      );
      await tryRpc<{
        liability: string;
        account_code: string;
        subledger_balance: string;
        ledger_balance: string;
      }>("payroll_reconciliation", asOf, (rows) =>
        rows.forEach((r) =>
          add(`Payroll: ${r.liability} (${r.account_code})`, r.subledger_balance, r.ledger_balance),
        ),
      );
      notes.push("Payroll lines appear only for users with payroll access.");
      subtitle = `As of ${o.to}`;
      rangeStart = null;
      break;
    }
  }

  const periods = await rpc<{ status: string }[]>(sb, "report_period_status", {
    p_client_id: clientId,
    p_from: rangeStart ?? (await fiscalYearStart(sb, clientId, o.to)),
    p_to: o.to,
  });
  return {
    title,
    subtitle,
    table,
    drill,
    openPeriods: periods.filter((p) => p.status === "open").length,
    checks,
    notes,
  };
}

function toText(c: bigint): string {
  const n = c < 0n;
  const a = n ? -c : c;
  return `${n ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

export interface AccountLine {
  entry_id: string;
  entry_no: number;
  entry_date: string;
  entry_type: string;
  memo: string;
  source_type: string | null;
  source_ref: string | null;
  line_no: number;
  description: string | null;
  debit: string;
  credit: string;
}
export async function accountLines(
  clientId: string,
  accountId: string,
  from: string | null,
  to: string,
  closing: boolean,
): Promise<AccountLine[]> {
  const sb = await createSupabaseServerClient();
  return rpc<AccountLine[]>(sb, "report_account_lines", {
    p_client_id: clientId,
    p_account_id: accountId,
    p_from: from,
    p_to: to,
    p_include_closing: closing,
  });
}

/** Parses report options from query parameters (with safe defaults). */
export function parseOptions(
  sp: Record<string, string | string[] | undefined>,
  today: string,
  allowed: readonly ReportKey[] = Object.keys(REPORTS) as ReportKey[],
): ReportOptions {
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const report = (allowed as string[]).includes(str("report"))
    ? (str("report") as ReportKey)
    : allowed[0];
  const to = isDate(str("to")) ? str("to") : today;
  let from = isDate(str("from")) ? str("from") : `${to.slice(0, 4)}-01-01`;
  if (from > to) from = to;
  const compare = (["previous", "prior_year"] as const).find((c) => c === str("compare")) ?? "none";
  return {
    report,
    from,
    to,
    compare,
    rounding: str("rounding") === "peso" ? "peso" : "centavo",
    includeZero: str("zero") === "1",
  };
}
