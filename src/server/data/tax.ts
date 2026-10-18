import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromDbError } from "@/server/db/errors";

/* Tax registry and client tax data (RLS: firm staff / assigned staff only). */

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

export interface TaxRuleRow {
  id: string;
  code: string;
  version: number;
  name: string;
  tax_type: string;
  status: string;
  effective_from: string;
  effective_to: string | null;
}
export const listTaxRules = () =>
  q<TaxRuleRow[]>("tax rules", (sb) =>
    sb
      .from("tax_rules")
      .select("id, code, version, name, tax_type, status, effective_from, effective_to")
      .order("code")
      .order("version", { ascending: false }),
  );

export interface TaxRuleDetail extends TaxRuleRow {
  description: string | null;
  eligibility: unknown[];
  inputs: { name: string; label?: string; source: "ledger" | "manual" }[];
  params: Record<string, unknown>;
  formula: { steps: { name: string; expr: unknown }[]; outputs: string[] };
  rounding: { places: number; mode: string };
  sources: {
    citation: string;
    title?: string;
    url?: string;
    issued_on?: string;
    section?: string;
  }[];
  review_note: string | null;
  entered_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
}
export const getTaxRule = (id: string) =>
  q<TaxRuleDetail | null>("tax rule", (sb) =>
    sb
      .from("tax_rules")
      .select(
        "id, code, version, name, tax_type, status, effective_from, effective_to, description, eligibility, inputs, params, formula, rounding, sources, review_note, entered_by, approved_by, approved_at",
      )
      .eq("id", id)
      .maybeSingle(),
  );

export interface FixtureResult {
  fixture_id: string;
  name: string;
  kind: string;
  as_of: string;
  reviewed: boolean;
  passed: boolean;
  expected: Record<string, unknown>;
  actual: Record<string, unknown> | null;
  error: string | null;
}
export const getFixtureResults = (ruleId: string) =>
  q<FixtureResult[]>("tax_rule_fixture_results", (sb) =>
    sb.rpc("tax_rule_fixture_results", { p_rule_id: ruleId }),
  );

export interface FixtureRow {
  id: string;
  name: string;
  basis: string;
  facts: Record<string, unknown>;
  inputs: Record<string, unknown>;
  created_by: string | null;
  reviewed_by: string | null;
  review_note: string | null;
}
export const listFixtures = (ruleId: string) =>
  q<FixtureRow[]>("tax fixtures", (sb) =>
    sb
      .from("tax_rule_fixtures")
      .select("id, name, basis, facts, inputs, created_by, reviewed_by, review_note")
      .eq("rule_id", ruleId),
  );

export interface RegressionRow {
  fixture_id: string;
  fixture_name: string;
  as_of: string;
  written_for: number;
  ran_with: number | null;
  passed: boolean;
  error: string | null;
}
export const getRegression = (code: string) =>
  q<RegressionRow[]>("tax_regression", (sb) => sb.rpc("tax_regression", { p_code: code }));

// --- client ---------------------------------------------------------------
export interface TaxProfile {
  attributes: Record<string, unknown>;
  status: string;
  proposed_by: string | null;
  confirmed_at: string | null;
}
export const getTaxProfile = (clientId: string) =>
  q<TaxProfile | null>("tax profile", (sb) =>
    sb
      .from("tax_profiles")
      .select("attributes, status, proposed_by, confirmed_at")
      .eq("client_id", clientId)
      .maybeSingle(),
  );

export interface ObligationRow {
  id: string;
  rule_code: string;
  starts_on: string;
  ends_on: string | null;
  notes: string | null;
}
export const listObligations = (clientId: string) =>
  q<ObligationRow[]>("tax obligations", (sb) =>
    sb
      .from("tax_obligations")
      .select("id, rule_code, starts_on, ends_on, notes")
      .eq("client_id", clientId)
      .order("rule_code"),
  );

export interface MappingRow {
  rule_code: string;
  input_name: string;
  account_ids: string[];
  sign: string;
}
export const listMappings = (clientId: string) =>
  q<MappingRow[]>("tax mappings", (sb) =>
    sb
      .from("tax_input_mappings")
      .select("rule_code, input_name, account_ids, sign")
      .eq("client_id", clientId),
  );

export interface ComputationRow {
  id: string;
  rule_code: string;
  rule_id: string | null;
  period_from: string;
  period_to: string;
  status: string;
  reason: string | null;
  outputs: Record<string, string> | null;
  prepared_by: string | null;
  prepared_at: string;
}
const COMP_COLS =
  "id, rule_code, rule_id, period_from, period_to, status, reason, outputs, prepared_by, prepared_at";
export const listComputations = (clientId: string) =>
  q<ComputationRow[]>("tax computations", (sb) =>
    sb
      .from("tax_computations")
      .select(COMP_COLS)
      .eq("client_id", clientId)
      .order("prepared_at", { ascending: false })
      .limit(200),
  );

export interface ComputationDetail extends ComputationRow {
  facts: Record<string, unknown>;
  ledger_inputs: Record<string, string>;
  adjustments: Record<string, string>;
  inputs: Record<string, string>;
  review_note: string | null;
  reviewed_at: string | null;
}
export async function getComputation(clientId: string, id: string) {
  const c = await q<ComputationDetail | null>("tax computation", (sb) =>
    sb
      .from("tax_computations")
      .select(`${COMP_COLS}, facts, ledger_inputs, adjustments, inputs, review_note, reviewed_at`)
      .eq("client_id", clientId)
      .eq("id", id)
      .maybeSingle(),
  );
  if (!c) return null;
  const [adjustments, lineage] = await Promise.all([
    q<
      { id: string; input_name: string; amount: string; reason: string; reference: string | null }[]
    >("tax adjustments", (sb) =>
      sb
        .from("tax_adjustments")
        .select("id, input_name, amount::text, reason, reference")
        .eq("computation_id", id),
    ),
    q<
      {
        id: number;
        input_name: string;
        entry_id: string;
        entry_no: number | null;
        entry_date: string;
        source_type: string | null;
        source_ref: string | null;
        amount: string;
      }[]
    >("tax lineage", (sb) =>
      sb
        .from("tax_lineage")
        .select(
          "id, input_name, entry_id, entry_no, entry_date, source_type, source_ref, amount::text",
        )
        .eq("computation_id", id)
        .order("entry_date")
        .limit(2000),
    ),
  ]);
  return { ...c, adjustmentRows: adjustments, lineage };
}
