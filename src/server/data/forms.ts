import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";
import type { FixtureResult, RegressionRow } from "@/server/data/tax";

/* Tax forms registry and workpapers (RLS: firm staff / assigned staff only). */

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

export interface TaxFormRow {
  id: string;
  form_code: string;
  version: number;
  title: string;
  official_version: string;
  frequency: string;
  status: string;
  effective_from: string;
  effective_to: string | null;
}
const FORM_COLS =
  "id, form_code, version, title, official_version, frequency, status, effective_from, effective_to";
export const listForms = () =>
  q<TaxFormRow[]>("tax forms", (sb) =>
    sb
      .from("tax_forms")
      .select(FORM_COLS)
      .order("form_code")
      .order("version", { ascending: false }),
  );

export interface FormLine {
  code: string;
  label: string;
  kind: "tax_output" | "tax_input" | "manual" | "fact" | "formula";
  rule_code?: string;
  output?: string;
  input?: string;
  fact?: string;
  expr?: unknown;
}
export interface TaxFormDetail extends TaxFormRow {
  eligibility: unknown[];
  definition: {
    lines: FormLine[];
    schedules?: { code: string; title: string; rule_code: string; input: string }[];
    validations?: { code: string; severity: string; message: string }[];
  };
  rounding: { places: number; mode: string };
  sources: { citation: string; title?: string; url?: string; issued_on?: string }[];
  export_format: string;
  limitations: string;
  review_note: string | null;
  entered_by: string | null;
  signoff_statement: string | null;
  signoff_evidence: string | null;
  signoff_at: string | null;
}
export const getForm = (id: string) =>
  q<TaxFormDetail | null>("tax form", (sb) =>
    sb
      .from("tax_forms")
      .select(
        `${FORM_COLS}, eligibility, definition, rounding, sources, export_format, limitations, review_note, entered_by, signoff_statement, signoff_evidence, signoff_at`,
      )
      .eq("id", id)
      .maybeSingle(),
  );
export const getFormFixtureResults = (formId: string) =>
  q<FixtureResult[]>("tax_form_fixture_results", (sb) =>
    sb.rpc("tax_form_fixture_results", { p_form_id: formId }),
  );
export const listFormFixtures = (formId: string) =>
  q<{ id: string; created_by: string | null }[]>("form fixtures", (sb) =>
    sb.from("tax_form_fixtures").select("id, created_by").eq("form_id", formId),
  );
export const getFormRegression = (code: string) =>
  q<RegressionRow[]>("form_regression", (sb) => sb.rpc("form_regression", { p_code: code }));

export interface WorkpaperRow {
  id: string;
  form_code: string;
  form_id: string | null;
  period_from: string;
  period_to: string;
  status: string;
  reason: string | null;
  prepared_by: string | null;
  prepared_at: string;
}
const WP_COLS =
  "id, form_code, form_id, period_from, period_to, status, reason, prepared_by, prepared_at";
export const listWorkpapers = (clientId: string) =>
  q<WorkpaperRow[]>("workpapers", (sb) =>
    sb
      .from("tax_workpapers")
      .select(WP_COLS)
      .eq("client_id", clientId)
      .order("prepared_at", { ascending: false })
      .limit(200),
  );

export interface WorkpaperDetail extends WorkpaperRow {
  lines: Record<string, string>;
  line_sources: Record<string, Record<string, unknown>>;
  messages: { code: string; severity: string; message: string }[];
  signoff_statement: string | null;
  signed_off_at: string | null;
}
export async function getWorkpaper(clientId: string, id: string) {
  const w = await q<WorkpaperDetail | null>("workpaper", (sb) =>
    sb
      .from("tax_workpapers")
      .select(`${WP_COLS}, lines, line_sources, messages, signoff_statement, signed_off_at`)
      .eq("client_id", clientId)
      .eq("id", id)
      .maybeSingle(),
  );
  if (!w) return null;
  const [entries, events, schedule, form] = await Promise.all([
    q<
      {
        id: string;
        line_code: string;
        kind: string;
        value: string;
        computed: string | null;
        reason: string;
        reference: string | null;
      }[]
    >("workpaper entries", (sb) =>
      sb
        .from("tax_workpaper_entries")
        .select("id, line_code, kind, value::text, computed::text, reason, reference")
        .eq("workpaper_id", id),
    ),
    q<{ id: number; event: string; detail: string | null; occurred_at: string }[]>(
      "workpaper events",
      (sb) =>
        sb
          .from("tax_workpaper_events")
          .select("id, event, detail, occurred_at")
          .eq("workpaper_id", id)
          .order("id"),
    ),
    q<
      {
        schedule_code: string;
        schedule_title: string;
        entry_id: string;
        entry_no: number;
        entry_date: string;
        source_type: string | null;
        source_ref: string | null;
        amount: string;
      }[]
    >("workpaper_schedule", (sb) => sb.rpc("workpaper_schedule", { p_workpaper_id: id })),
    w.form_id ? getForm(w.form_id) : Promise.resolve(null),
  ]);
  return { ...w, entries, events, schedule, form };
}
