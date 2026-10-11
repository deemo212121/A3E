import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

/*
 * Payroll read models. Payroll RLS returns rows ONLY to users with an explicit
 * payroll grant for the client, so these return nothing for anyone else.
 */

async function q<T>(
  label: string,
  run: (
    sb: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
) {
  const { data, error } = await run(await createSupabaseServerClient());
  if (error) throw fromDbError(error, label);
  return data as T;
}
const one = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

export interface PayrollAccessRow {
  user_id: string;
  access_level: string;
  granted_at: string;
  name: string;
  email: string;
}
export async function listPayrollAccess(clientId: string): Promise<PayrollAccessRow[]> {
  const rows = await q<Record<string, unknown>[]>("payroll access", (sb) =>
    sb
      .from("payroll_access")
      .select(
        "user_id, access_level, granted_at, profiles!payroll_access_user_id_fkey(full_name, email)",
      )
      .eq("client_id", clientId),
  );
  return rows.map((r) => {
    const p = one(r.profiles as { full_name: string; email: string } | null);
    return {
      user_id: r.user_id as string,
      access_level: r.access_level as string,
      granted_at: r.granted_at as string,
      name: p?.full_name ?? "",
      email: p?.email ?? "",
    };
  });
}

export interface PayrollSettings {
  net_pay_account_id: string;
  employer_expense_account_id: string;
  sss_payable_account_id: string;
  philhealth_payable_account_id: string;
  pagibig_payable_account_id: string;
  withholding_payable_account_id: string;
}
export const getPayrollSettings = (clientId: string) =>
  q<PayrollSettings | null>("payroll settings", (sb) =>
    sb
      .from("payroll_settings")
      .select(
        "net_pay_account_id, employer_expense_account_id, sss_payable_account_id, philhealth_payable_account_id, pagibig_payable_account_id, withholding_payable_account_id",
      )
      .eq("client_id", clientId)
      .maybeSingle(),
  );

export interface PayrollItemRow {
  id: string;
  code: string;
  name: string;
  kind: "earning" | "deduction";
  account_id: string;
  unit: "amount" | "days" | "hours";
  multiplier: string;
  is_basic: boolean;
  is_taxable: boolean;
  in_sss_base: boolean;
  in_philhealth_base: boolean;
  in_pagibig_base: boolean;
  status: string;
  proposed_by: string | null;
}
export const listPayrollItems = (clientId: string) =>
  q<PayrollItemRow[]>("pay items", (sb) =>
    sb
      .from("payroll_items")
      .select(
        "id, code, name, kind, account_id, unit, multiplier::text, is_basic, is_taxable, in_sss_base, in_philhealth_base, in_pagibig_base, status, proposed_by",
      )
      .eq("client_id", clientId)
      .order("kind")
      .order("code"),
  );

export interface RuleBracket {
  seq: number;
  lower_bound: string;
  upper_bound: string | null;
  ee_amount: string | null;
  er_amount: string | null;
  ec_amount: string | null;
  ee_rate: string | null;
  er_rate: string | null;
  fixed_tax: string | null;
  excess_rate: string | null;
}
export interface RuleSetRow {
  id: string;
  kind: string;
  version: number;
  method: string;
  description: string;
  legal_basis: string;
  effective_from: string;
  effective_to: string | null;
  base_floor: string | null;
  base_ceiling: string | null;
  frequency: string | null;
  deduct_employee_contributions: boolean | null;
  status: string;
  entered_by: string | null;
  brackets: RuleBracket[];
}
export async function listRuleSets(): Promise<RuleSetRow[]> {
  const rows = await q<(RuleSetRow & { payroll_rule_brackets: RuleBracket[] })[]>(
    "payroll rules",
    (sb) =>
      sb
        .from("payroll_rule_sets")
        .select(
          "id, kind, version, method, description, legal_basis, effective_from, effective_to, base_floor::text, base_ceiling::text, frequency, deduct_employee_contributions, status, entered_by, payroll_rule_brackets(seq, lower_bound::text, upper_bound::text, ee_amount::text, er_amount::text, ec_amount::text, ee_rate::text, er_rate::text, fixed_tax::text, excess_rate::text)",
        )
        .order("kind")
        .order("version", { ascending: false }),
  );
  return rows.map(({ payroll_rule_brackets, ...r }) => ({
    ...r,
    brackets: [...(payroll_rule_brackets ?? [])].sort((a, b) => a.seq - b.seq),
  }));
}

export interface EmployeeRow {
  id: string;
  employee_no: string;
  last_name: string;
  first_name: string;
  middle_name: string | null;
  tin: string | null;
  sss_no: string | null;
  philhealth_no: string | null;
  pagibig_no: string | null;
  position: string | null;
  hire_date: string;
  termination_date: string | null;
  termination_reason: string | null;
  withholding_exempt: boolean;
  exempt_reason: string | null;
}
const EMPLOYEE_COLS =
  "id, employee_no, last_name, first_name, middle_name, tin, sss_no, philhealth_no, pagibig_no, position, hire_date, termination_date, termination_reason, withholding_exempt, exempt_reason";
export const listEmployees = (clientId: string) =>
  q<EmployeeRow[]>("employees", (sb) =>
    sb.from("employees").select(EMPLOYEE_COLS).eq("client_id", clientId).order("employee_no"),
  );

export interface RateRow {
  id: string;
  effective_from: string;
  pay_basis: string;
  basic_rate: string;
  daily_rate: string;
  hourly_rate: string;
}
export async function getEmployee(
  clientId: string,
  id: string,
): Promise<(EmployeeRow & { rates: RateRow[] }) | null> {
  const d = await q<(EmployeeRow & { employee_rates: RateRow[] }) | null>("employee", (sb) =>
    sb
      .from("employees")
      .select(
        `${EMPLOYEE_COLS}, employee_rates(id, effective_from, pay_basis, basic_rate::text, daily_rate::text, hourly_rate::text)`,
      )
      .eq("client_id", clientId)
      .eq("id", id)
      .maybeSingle(),
  );
  if (!d) return null;
  const { employee_rates, ...e } = d;
  return {
    ...e,
    rates: [...(employee_rates ?? [])].sort((a, b) =>
      b.effective_from.localeCompare(a.effective_from),
    ),
  };
}

const RUN_COLS =
  "id, frequency, period_start, period_end, pay_date, status, memo, gross_pay::text, employee_contributions::text, employer_contributions::text, withholding_tax::text, other_deductions::text, net_pay::text, prepared_by, review_comment, journal_entry_id, cancel_journal_entry_id, cancel_reason, row_version";
export interface RunRow {
  id: string;
  frequency: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: string;
  memo: string | null;
  gross_pay: string;
  employee_contributions: string;
  employer_contributions: string;
  withholding_tax: string;
  other_deductions: string;
  net_pay: string;
  prepared_by: string | null;
  review_comment: string | null;
  journal_entry_id: string | null;
  cancel_journal_entry_id: string | null;
  cancel_reason: string | null;
  row_version: number;
}
export const listRuns = (clientId: string) =>
  q<RunRow[]>("payroll runs", (sb) =>
    sb
      .from("payroll_runs")
      .select(RUN_COLS)
      .eq("client_id", clientId)
      .order("period_start", { ascending: false })
      .limit(200),
  );

export interface PayslipRow {
  id: string;
  employee_id: string;
  employee_no: string;
  employee_name: string;
  gross_pay: string;
  taxable_pay: string;
  sss_base: string;
  philhealth_base: string;
  pagibig_base: string;
  sss_ee: string;
  sss_er: string;
  sss_ec: string;
  philhealth_ee: string;
  philhealth_er: string;
  pagibig_ee: string;
  pagibig_er: string;
  withholding_tax: string;
  other_deductions: string;
  net_pay: string;
  notes: string | null;
  lines: {
    line_no: number;
    item_id: string;
    description: string | null;
    quantity: string | null;
    rate: string | null;
    amount: string;
  }[];
}
const PAYSLIP_COLS =
  "id, run_id, employee_id, gross_pay::text, taxable_pay::text, sss_base::text, philhealth_base::text, pagibig_base::text, sss_ee::text, sss_er::text, sss_ec::text, philhealth_ee::text, philhealth_er::text, pagibig_ee::text, pagibig_er::text, withholding_tax::text, other_deductions::text, net_pay::text, notes, employees(employee_no, last_name, first_name), payroll_lines(line_no, item_id, description, quantity::text, rate::text, amount::text)";
function toPayslip(r: Record<string, unknown>): PayslipRow & { run_id: string } {
  const e = one(r.employees as { employee_no: string; last_name: string; first_name: string });
  const { employees: _e, payroll_lines, ...rest } = r;
  void _e;
  return {
    ...(rest as unknown as PayslipRow & { run_id: string }),
    employee_no: e?.employee_no ?? "",
    employee_name: e ? `${e.last_name}, ${e.first_name}` : "",
    lines: [...((payroll_lines as PayslipRow["lines"]) ?? [])].sort(
      (a, b) => a.line_no - b.line_no,
    ),
  };
}

export interface PaymentRow {
  id: string;
  kind: string;
  item_id: string | null;
  payment_date: string;
  amount: string;
  reference: string | null;
  status: string;
  prepared_by: string | null;
  journal_entry_id: string | null;
}
export async function getRun(clientId: string, id: string) {
  const run = await q<RunRow | null>("payroll run", (sb) =>
    sb.from("payroll_runs").select(RUN_COLS).eq("client_id", clientId).eq("id", id).maybeSingle(),
  );
  if (!run) return null;
  const [payslips, payments] = await Promise.all([
    q<Record<string, unknown>[]>("payslips", (sb) =>
      sb.from("payroll_payslips").select(PAYSLIP_COLS).eq("client_id", clientId).eq("run_id", id),
    ),
    q<PaymentRow[]>("payroll payments", (sb) =>
      sb
        .from("payroll_payments")
        .select(
          "id, kind, item_id, payment_date, amount::text, reference, status, prepared_by, journal_entry_id",
        )
        .eq("client_id", clientId)
        .eq("run_id", id)
        .order("payment_date"),
    ),
  ]);
  return {
    ...run,
    payslips: payslips.map(toPayslip).sort((a, b) => a.employee_no.localeCompare(b.employee_no)),
    payments,
  };
}

export async function getPayslip(clientId: string, id: string) {
  const r = await q<Record<string, unknown> | null>("payslip", (sb) =>
    sb
      .from("payroll_payslips")
      .select(PAYSLIP_COLS)
      .eq("client_id", clientId)
      .eq("id", id)
      .maybeSingle(),
  );
  if (!r) return null;
  const p = toPayslip(r);
  const run = await q<RunRow | null>("payroll run", (sb) =>
    sb
      .from("payroll_runs")
      .select(RUN_COLS)
      .eq("client_id", clientId)
      .eq("id", p.run_id)
      .maybeSingle(),
  );
  return run ? { ...p, run } : null;
}

export interface PayrollReconRow {
  liability: string;
  account_id: string;
  account_code: string;
  subledger_balance: string;
  ledger_balance: string;
  difference: string;
}
export const getPayrollReconciliation = (clientId: string, asOf: string) =>
  q<PayrollReconRow[]>("payroll_reconciliation", (sb) =>
    sb.rpc("payroll_reconciliation", { p_client_id: clientId, p_as_of: asOf }),
  );

export interface MonthSummaryRow {
  employee_id: string;
  employee_no: string;
  employee_name: string;
  gross_pay: string;
  sss_ee: string;
  sss_er: string;
  sss_ec: string;
  philhealth_ee: string;
  philhealth_er: string;
  pagibig_ee: string;
  pagibig_er: string;
  withholding_tax: string;
  net_pay: string;
}
export const getMonthSummary = (clientId: string, month: string) =>
  q<MonthSummaryRow[]>("payroll_month_summary", (sb) =>
    sb.rpc("payroll_month_summary", { p_client_id: clientId, p_month: month }),
  );

export interface PayrollEventRow {
  id: number;
  from_status: string | null;
  to_status: string;
  comment: string | null;
  occurred_at: string;
}
export const getPayrollEvents = (clientId: string, subject: string, subjectId: string) =>
  q<PayrollEventRow[]>("payroll history", (sb) =>
    sb
      .from("payroll_events")
      .select("id, from_status, to_status, comment, occurred_at")
      .eq("client_id", clientId)
      .eq("subject", subject)
      .eq("subject_id", subjectId)
      .order("occurred_at"),
  );
