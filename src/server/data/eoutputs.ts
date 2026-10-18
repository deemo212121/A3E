import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";
import type { FixtureResult } from "@/server/data/tax";

/* Electronic outputs and e-invoicing register (RLS: firm staff / assigned staff). */

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

export interface SpecRow {
  id: string;
  output_code: string;
  version: number;
  output_type: string;
  title: string;
  status: string;
  effective_from: string;
  effective_to: string | null;
  official_tool: string | null;
  official_tool_version: string | null;
}
const SPEC_COLS =
  "id, output_code, version, output_type, title, status, effective_from, effective_to, official_tool, official_tool_version";
export const listSpecs = () =>
  q<SpecRow[]>("output specs", (sb) =>
    sb
      .from("output_specs")
      .select(SPEC_COLS)
      .order("output_code")
      .order("version", { ascending: false }),
  );

export interface SpecDetail extends SpecRow {
  spec_source: Record<string, string>;
  dataset: string;
  layout: Record<string, unknown>;
  limitations: string;
  review_note: string | null;
  entered_by: string | null;
  signoff_statement: string | null;
  signoff_evidence: string | null;
}
export const getSpec = (id: string) =>
  q<SpecDetail | null>("output spec", (sb) =>
    sb
      .from("output_specs")
      .select(
        `${SPEC_COLS}, spec_source, dataset, layout, limitations, review_note, entered_by, signoff_statement, signoff_evidence`,
      )
      .eq("id", id)
      .maybeSingle(),
  );
export const getSpecFixtureResults = (id: string) =>
  q<FixtureResult[]>("output_fixture_results", (sb) =>
    sb.rpc("output_fixture_results", { p_spec_id: id }),
  );
export const listSpecFixtures = (id: string) =>
  q<{ id: string; created_by: string | null }[]>("output fixtures", (sb) =>
    sb.from("output_spec_fixtures").select("id, created_by").eq("spec_id", id),
  );

export interface RunRow {
  id: string;
  output_code: string;
  spec_id: string | null;
  period_from: string;
  period_to: string;
  status: string;
  reason: string | null;
  filename: string | null;
  precheck_passed: boolean;
  generated_by: string | null;
  generated_at: string;
}
const RUN_COLS =
  "id, output_code, spec_id, period_from, period_to, status, reason, filename, precheck_passed, generated_by, generated_at";
export const listRuns = (clientId: string) =>
  q<RunRow[]>("output runs", (sb) =>
    sb
      .from("output_runs")
      .select(RUN_COLS)
      .eq("client_id", clientId)
      .order("generated_at", { ascending: false })
      .limit(200),
  );

export interface RunDetail extends RunRow {
  content: string | null;
  content_sha256: string | null;
  snapshot_sha256: string | null;
  snapshot: unknown[];
  messages: {
    code: string;
    severity: string;
    record?: string;
    row?: number;
    field?: string;
    message: string;
  }[];
  reconciliation: { check: string; expected: unknown; actual: unknown; passed: boolean }[];
  signoff_statement: string | null;
}
export async function getRun(clientId: string, id: string) {
  const r = await q<RunDetail | null>("output run", (sb) =>
    sb
      .from("output_runs")
      .select(
        `${RUN_COLS}, content, content_sha256, snapshot_sha256, snapshot, messages, reconciliation, signoff_statement`,
      )
      .eq("client_id", clientId)
      .eq("id", id)
      .maybeSingle(),
  );
  if (!r) return null;
  const [validations, spec] = await Promise.all([
    q<
      {
        id: string;
        kind: string;
        tool: string;
        tool_version: string | null;
        result: string;
        log: string;
        reference: string | null;
        recorded_at: string;
      }[]
    >("output validations", (sb) =>
      sb
        .from("output_validations")
        .select("id, kind, tool, tool_version, result, log, reference, recorded_at")
        .eq("run_id", id)
        .order("recorded_at"),
    ),
    r.spec_id ? getSpec(r.spec_id) : Promise.resolve(null),
  ]);
  return { ...r, validations, spec };
}

export interface RequirementRow {
  id: string;
  code: string;
  category: string;
  title: string;
  description: string;
  sources: { citation: string; issued_on?: string; url?: string }[];
  status: string;
  entered_by: string | null;
}
export const listRequirements = () =>
  q<RequirementRow[]>("e-invoicing requirements", (sb) =>
    sb
      .from("einvoice_requirements")
      .select("id, code, category, title, description, sources, status, entered_by")
      .order("code"),
  );

export interface AssessmentRow {
  id: string;
  requirement_id: string;
  status: string;
  evidence: string | null;
  note: string | null;
  assessed_at: string;
}
export const listAssessments = (clientId: string) =>
  q<AssessmentRow[]>("e-invoicing assessments", (sb) =>
    sb
      .from("client_einvoice_assessments")
      .select("id, requirement_id, status, evidence, note, assessed_at")
      .eq("client_id", clientId)
      .order("assessed_at", { ascending: false }),
  );
