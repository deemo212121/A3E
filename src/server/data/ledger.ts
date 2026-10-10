import "server-only";

import { sumAmounts } from "@/lib/money/amount";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

/*
 * Ledger read models. User-scoped client only: RLS decides visibility.
 * Amounts are selected as TEXT (::text) so they never become JS floats.
 */

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  account_type: string;
  normal_balance: string;
  is_postable: boolean;
  is_active: boolean;
}

export async function listAccounts(clientId: string): Promise<AccountRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounts")
    .select("id, code, name, account_type, normal_balance, is_postable, is_active")
    .eq("client_id", clientId)
    .order("code");
  if (error) throw fromDbError(error, "select accounts");
  return data ?? [];
}

export interface PeriodRow {
  id: string;
  fiscal_year_id: string;
  period_no: number;
  start_date: string;
  end_date: string;
  status: "open" | "soft_closed" | "locked";
  status_reason: string | null;
}

export interface FiscalYearRow {
  id: string;
  start_date: string;
  end_date: string;
  next_entry_no: number;
  periods: PeriodRow[];
}

export async function listFiscalYears(clientId: string): Promise<FiscalYearRow[]> {
  const supabase = await createSupabaseServerClient();
  const [{ data: years, error: yErr }, { data: periods, error: pErr }] = await Promise.all([
    supabase
      .from("fiscal_years")
      .select("id, start_date, end_date, next_entry_no")
      .eq("client_id", clientId)
      .order("start_date", { ascending: false }),
    supabase
      .from("accounting_periods")
      .select("id, fiscal_year_id, period_no, start_date, end_date, status, status_reason")
      .eq("client_id", clientId)
      .order("start_date"),
  ]);
  if (yErr) throw fromDbError(yErr, "select fiscal years");
  if (pErr) throw fromDbError(pErr, "select periods");
  return (years ?? []).map((y) => ({
    ...y,
    periods: (periods ?? []).filter((p) => p.fiscal_year_id === y.id) as PeriodRow[],
  }));
}

export interface EntryListRow {
  id: string;
  entry_no: number | null;
  entry_date: string;
  entry_type: string;
  status: string;
  memo: string;
  source_type: string | null;
  source_ref: string | null;
  total: string;
}

export async function listEntries(clientId: string, statuses?: string[]): Promise<EntryListRow[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("journal_entries")
    .select(
      "id, entry_no, entry_date, entry_type, status, memo, source_type, source_ref, journal_lines(debit::text)",
    )
    .eq("client_id", clientId)
    .order("entry_date", { ascending: false })
    .order("entry_no", { ascending: false, nullsFirst: true })
    .limit(500);
  if (statuses && statuses.length > 0) query = query.in("status", statuses);
  const { data, error } = await query;
  if (error) throw fromDbError(error, "select journal entries");
  return (data ?? []).map((e) => {
    const lines = (e.journal_lines ?? []) as { debit: string }[];
    return {
      id: e.id,
      entry_no: e.entry_no,
      entry_date: e.entry_date,
      entry_type: e.entry_type,
      status: e.status,
      memo: e.memo,
      source_type: e.source_type,
      source_ref: e.source_ref,
      total: sumAmounts(lines.map((l) => l.debit)),
    };
  });
}

export interface EntryDetail {
  id: string;
  client_id: string;
  entry_no: number | null;
  entry_date: string;
  entry_type: string;
  status: string;
  memo: string;
  source_type: string | null;
  source_ref: string | null;
  review_comment: string | null;
  void_reason: string | null;
  prepared_by: string | null;
  approved_by: string | null;
  posted_at: string | null;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  lines: {
    line_no: number;
    account_id: string;
    code: string;
    name: string;
    debit: string;
    credit: string;
    description: string | null;
  }[];
}

/** Returns null when the entry does not exist, is not visible, or belongs to another client. */
export async function getEntry(clientId: string, entryId: string): Promise<EntryDetail | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("journal_entries")
    .select(
      "id, client_id, entry_no, entry_date, entry_type, status, memo, source_type, source_ref, review_comment, void_reason, prepared_by, approved_by, posted_at, reverses_entry_id, reversed_by_entry_id, journal_lines(line_no, account_id, debit::text, credit::text, description, accounts!journal_lines_client_id_account_id_fkey(code, name))",
    )
    .eq("id", entryId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw fromDbError(error, "select journal entry");
  if (!data) return null;
  type RawLine = {
    line_no: number;
    account_id: string;
    debit: string;
    credit: string;
    description: string | null;
    accounts: { code: string; name: string } | { code: string; name: string }[] | null;
  };
  const lines = ((data.journal_lines ?? []) as RawLine[])
    .map((l) => {
      const a = Array.isArray(l.accounts) ? l.accounts[0] : l.accounts;
      return {
        line_no: l.line_no,
        account_id: l.account_id,
        code: a?.code ?? "",
        name: a?.name ?? "",
        debit: l.debit,
        credit: l.credit,
        description: l.description,
      };
    })
    .sort((x, y) => x.line_no - y.line_no);
  const { journal_lines: _omit, ...entry } = data;
  void _omit;
  return { ...(entry as Omit<EntryDetail, "lines">), lines };
}

export interface TrialBalanceRow {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  normal_balance: string;
  total_debit: string;
  total_credit: string;
  balance: string;
}

export async function getTrialBalance(clientId: string, asOf: string): Promise<TrialBalanceRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("trial_balance", {
    p_client_id: clientId,
    p_as_of: asOf,
  });
  if (error) throw fromDbError(error, "trial_balance");
  return (data ?? []) as TrialBalanceRow[];
}

export interface LedgerRow {
  entry_id: string;
  entry_no: number;
  entry_date: string;
  entry_type: string;
  memo: string;
  line_no: number;
  description: string | null;
  debit: string;
  credit: string;
  running_balance: string;
}

export async function getGeneralLedger(
  clientId: string,
  accountId: string,
  from: string,
  to: string,
): Promise<LedgerRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("general_ledger", {
    p_client_id: clientId,
    p_account_id: accountId,
    p_from: from,
    p_to: to,
  });
  if (error) throw fromDbError(error, "general_ledger");
  return (data ?? []) as LedgerRow[];
}

export interface ReviewQueueRow extends EntryListRow {
  client_id: string;
}

/** Submitted entries across every client the caller may see (RLS-scoped). */
export async function listReviewQueue(): Promise<ReviewQueueRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("journal_entries")
    .select(
      "id, client_id, entry_no, entry_date, entry_type, status, memo, source_type, source_ref, journal_lines(debit::text)",
    )
    .eq("status", "submitted")
    .order("submitted_at", { ascending: true })
    .limit(200);
  if (error) throw fromDbError(error, "select review queue");
  return (data ?? []).map((e) => ({
    id: e.id,
    client_id: e.client_id,
    entry_no: e.entry_no,
    entry_date: e.entry_date,
    entry_type: e.entry_type,
    status: e.status,
    memo: e.memo,
    source_type: e.source_type,
    source_ref: e.source_ref,
    total: sumAmounts(((e.journal_lines ?? []) as { debit: string }[]).map((l) => l.debit)),
  }));
}
