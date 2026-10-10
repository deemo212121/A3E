import "server-only";

import { randomUUID } from "node:crypto";

import Link from "next/link";

import { ActionForm, Field, Select } from "@/components/ui/action-form";
import { DataTable } from "@/components/ui/data-table";
import { Alert, Badge, Section } from "@/components/ui/primitives";
import {
  cancelImportAction,
  commitImportAction,
  rereadImportAction,
  saveMappingAction,
  startImportAction,
} from "@/features/intake/document-actions";
import { IMPORT_ACCEPT } from "@/lib/intake/files";
import { fieldsFor, suggestMapping, type ImportTarget } from "@/lib/intake/mapping";
import { COUNTERPARTY_KINDS, TXN_KINDS } from "@/lib/intake/rules";
import type { Access } from "@/server/auth/access";
import {
  getImportRows,
  listImports,
  type ImportBatchRow,
  type ImportRowView,
} from "@/server/data/intake";
import { canWriteIntake } from "@/server/intake/access";

const BATCH_STATUS: Record<
  string,
  { label: string; tone: "neutral" | "info" | "success" | "warning" }
> = {
  uploaded: { label: "Columns not mapped yet", tone: "warning" },
  mapped: { label: "Ready to import", tone: "info" },
  committed: { label: "Imported", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const OUTCOME: Record<
  string,
  { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }
> = {
  pending: { label: "Not checked", tone: "neutral" },
  valid: { label: "Ready", tone: "success" },
  invalid: { label: "Error", tone: "danger" },
  duplicate: { label: "Duplicate", tone: "warning" },
  possible_duplicate: { label: "Possible duplicate", tone: "warning" },
  imported: { label: "Imported", tone: "success" },
  skipped: { label: "Skipped", tone: "neutral" },
};

/** List of imports + the form to start one. */
export async function ImportsList({
  access,
  clientId,
  batchHref,
}: {
  access: Access;
  clientId: string;
  batchHref: (id: string) => string;
}) {
  const writer = canWriteIntake(access, clientId);
  const batches = await listImports(clientId);
  return (
    <>
      {writer ? (
        <Section title="Import from a spreadsheet">
          <p className="mb-3 text-sm text-[var(--muted)]">
            Upload a .csv or .xlsx file (up to 5 MB, 5,000 rows). You will match its columns, see
            every row checked, and confirm before anything is created. Imported records are
            submitted to the firm for review; nothing is posted to the books automatically.
          </p>
          <ActionForm
            action={startImportAction}
            submitLabel="Upload and read the file"
            encType="multipart/form-data"
          >
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                label="What does the file contain?"
                name="target"
                options={[
                  { value: "transactions", label: "Transactions (sales, purchases, expenses…)" },
                  { value: "counterparties", label: "A list of customers or suppliers" },
                ]}
              />
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor="import-file">
                  File
                  <span aria-hidden className="text-[var(--danger)]">
                    {" "}
                    *
                  </span>
                </label>
                <input
                  id="import-file"
                  name="file"
                  type="file"
                  required
                  accept={IMPORT_ACCEPT}
                  className="rounded-md border border-dashed border-[var(--border)] bg-[var(--surface)] p-2"
                />
              </div>
              <Field
                label="Sheet name (optional)"
                name="sheetName"
                hint="Leave blank to use the first sheet."
              />
              <Field
                label="Header row (optional)"
                name="headerRow"
                inputMode="numeric"
                hint="The row with the column titles. Leave blank to detect it."
              />
            </div>
          </ActionForm>
        </Section>
      ) : null}
      <Section title="Imports">
        <DataTable
          caption="Imports"
          rows={batches}
          rowKey={(b) => b.id}
          empty="No imports yet."
          columns={[
            {
              header: "File",
              cell: (b) => (
                <Link
                  href={batchHref(b.id)}
                  className="font-medium break-all text-[var(--accent)] hover:underline"
                >
                  {b.documents?.original_filename ?? "Import"}
                  {b.sheet_name ? ` · ${b.sheet_name}` : ""}
                </Link>
              ),
            },
            {
              header: "Contains",
              cell: (b) => (b.target === "transactions" ? "Transactions" : "Customers/suppliers"),
            },
            { header: "Rows", kind: "num", cell: (b) => b.row_count },
            {
              header: "Status",
              cell: (b) => (
                <Badge tone={BATCH_STATUS[b.status]?.tone ?? "neutral"}>
                  {BATCH_STATUS[b.status]?.label ?? b.status}
                </Badge>
              ),
            },
            {
              header: "Started",
              kind: "nowrap",
              hideOnMobile: true,
              cell: (b) => b.created_at.slice(0, 10),
            },
          ]}
        />
      </Section>
    </>
  );
}

function rowSummary(target: string, r: ImportRowView): string {
  const n = r.normalized;
  if (!n) return r.raw.slice(0, 4).map(String).filter(Boolean).join(" · ");
  return target === "transactions"
    ? [n.txn_date, n.kind, n.document_ref, n.counterparty_name, n.gross_amount]
        .filter(Boolean)
        .join(" · ")
    : [n.registered_name, n.tin, n.kind].filter(Boolean).join(" · ");
}

/** One import: mapping, row-by-row preview, commit, summary. */
export async function ImportBatchView({
  access,
  clientId,
  batch,
  view,
  basePath,
}: {
  access: Access;
  clientId: string;
  batch: ImportBatchRow;
  view: string | undefined;
  basePath: string;
}) {
  const writer = canWriteIntake(access, clientId);
  const target = batch.target as ImportTarget;
  const fields = fieldsFor(target);
  const mapping =
    (batch.mapping as Record<string, number | null> | null) ??
    suggestMapping(batch.headers, target);
  const options = (batch.options ?? {}) as { dateFormat?: string; defaultKind?: string | null };
  const summary = batch.summary ?? {};
  const filter = view === "problems" ? ["invalid", "duplicate", "possible_duplicate"] : undefined;
  const rows =
    batch.status === "uploaded"
      ? (await getImportRows(batch.id)).slice(0, 10)
      : await getImportRows(batch.id, filter);
  const columnOptions = [
    { value: "", label: "— not in this file —" },
    ...batch.headers.map((h, i) => ({ value: String(i), label: h })),
  ];
  const kinds = target === "transactions" ? TXN_KINDS : COUNTERPARTY_KINDS;
  const open = batch.status === "uploaded" || batch.status === "mapped";

  return (
    <>
      <Section title="Summary">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={BATCH_STATUS[batch.status]?.tone ?? "neutral"}>
            {BATCH_STATUS[batch.status]?.label ?? batch.status}
          </Badge>
          <span>
            {batch.documents?.original_filename}
            {batch.sheet_name ? ` · sheet "${batch.sheet_name}"` : ""} · {batch.row_count} rows ·{" "}
            {target === "transactions" ? "transactions" : "customers/suppliers"}
          </span>
        </div>
        {batch.status !== "uploaded" ? (
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {Object.entries(summary)
              .filter(([k]) => k !== "total")
              .map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="text-[var(--muted)]">{OUTCOME[k]?.label ?? k}</dt>
                  <dd className="font-medium tabular-nums">{v}</dd>
                </div>
              ))}
          </dl>
        ) : null}
        {batch.status === "committed" ? (
          <div className="mt-3">
            <Alert tone="success" title="Import finished">
              The imported records were submitted to the firm for review. Rows marked as duplicates
              or errors were not imported.
            </Alert>
          </div>
        ) : null}
      </Section>

      {writer && open ? (
        <Section title="1. Match the columns">
          <ActionForm
            key={JSON.stringify([batch.mapping, batch.options])}
            action={saveMappingAction}
            submitLabel="Check all rows"
            variant="primary"
          >
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="batchId" value={batch.id} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {fields.map((f) => (
                <Select
                  key={f.key}
                  label={`${f.label}${f.required ? " *" : ""}`}
                  name={`col_${f.key}`}
                  options={columnOptions}
                  defaultValue={
                    mapping[f.key] === null || mapping[f.key] === undefined
                      ? ""
                      : String(mapping[f.key])
                  }
                />
              ))}
              <Select
                label={
                  target === "transactions"
                    ? "Type for rows without a type column"
                    : "Customer or supplier (if no column)"
                }
                name="defaultKind"
                options={[{ value: "", label: "— from the file —" }, ...kinds]}
                defaultValue={
                  options.defaultKind ?? (target === "counterparties" ? "supplier" : "")
                }
              />
              {target === "transactions" ? (
                <Select
                  label="Dates written as"
                  name="dateFormat"
                  options={[
                    { value: "MDY", label: "Month/Day/Year (09/03/2026)" },
                    { value: "DMY", label: "Day/Month/Year (03/09/2026)" },
                    { value: "YMD", label: "Year-Month-Day (2026-09-03)" },
                  ]}
                  defaultValue={options.dateFormat ?? "MDY"}
                />
              ) : null}
            </div>
            <p className="text-xs text-[var(--muted)]">
              Real Excel dates are read automatically; the format above applies to dates typed as
              text.
            </p>
          </ActionForm>
          <details className="mt-4 rounded-md border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm">Wrong sheet or header row?</summary>
            <div className="mt-3">
              <ActionForm action={rereadImportAction} submitLabel="Read the file again">
                <input type="hidden" name="clientId" value={clientId} />
                <input type="hidden" name="batchId" value={batch.id} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field
                    label="Sheet name"
                    name="sheetName"
                    defaultValue={batch.sheet_name ?? ""}
                  />
                  <Field label="Header row number" name="headerRow" inputMode="numeric" />
                </div>
              </ActionForm>
            </div>
          </details>
        </Section>
      ) : null}

      <Section
        title={
          batch.status === "uploaded"
            ? "First rows of the file"
            : batch.status === "mapped"
              ? "2. Check the rows"
              : "Rows"
        }
        actions={
          batch.status !== "uploaded" ? (
            <nav aria-label="Row filter" className="flex gap-2 text-sm">
              <Link className={view === "problems" ? "underline" : "font-medium"} href={basePath}>
                All rows
              </Link>
              <Link
                className={view === "problems" ? "font-medium" : "underline"}
                href={`${basePath}?view=problems`}
              >
                Only problems
              </Link>
            </nav>
          ) : null
        }
      >
        <DataTable
          caption="Import rows"
          rows={rows.slice(0, 500)}
          rowKey={(r) => String(r.row_no)}
          empty="No rows to show."
          columns={[
            { header: "Row", kind: "num", cell: (r) => r.row_no },
            {
              header: "Result",
              cell: (r) => (
                <Badge tone={OUTCOME[r.outcome]?.tone ?? "neutral"}>
                  {OUTCOME[r.outcome]?.label ?? r.outcome}
                </Badge>
              ),
            },
            {
              header: "Data",
              cell: (r) => <span className="break-words">{rowSummary(target, r)}</span>,
            },
            {
              header: "Details",
              cell: (r) =>
                r.errors.length ? (
                  <ul className="list-disc pl-4 text-xs text-[var(--danger)]">
                    {r.errors.map((e, i) => (
                      <li key={i}>{e.message}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-[var(--muted)]">{r.duplicate_note ?? ""}</span>
                ),
            },
          ]}
        />
        {rows.length > 500 ? (
          <p className="mt-2 text-xs text-[var(--muted)]">Showing the first 500 rows.</p>
        ) : null}
      </Section>

      {writer && batch.status === "mapped" ? (
        <Section title="3. Import">
          <ActionForm
            action={commitImportAction}
            submitLabel={`Import ${summary.valid ?? 0} ready row${summary.valid === 1 ? "" : "s"}`}
            variant="primary"
            confirmMessage="Create these records and submit them for review?"
          >
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="batchId" value={batch.id} />
            {(summary.possible_duplicate ?? 0) > 0 ? (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="includePossible" className="mt-1" />
                <span>
                  Also import the {summary.possible_duplicate} possible duplicate(s). Only tick this
                  if you checked they are really different transactions.
                </span>
              </label>
            ) : null}
            <p className="text-xs text-[var(--muted)]">
              Rows with errors and exact duplicates are never imported. Running the import twice
              does not create anything twice.
            </p>
          </ActionForm>
          <div className="mt-3">
            <ActionForm
              action={cancelImportAction}
              submitLabel="Cancel this import"
              variant="danger"
              confirmMessage="Cancel this import?"
            >
              <input type="hidden" name="clientId" value={clientId} />
              <input type="hidden" name="batchId" value={batch.id} />
            </ActionForm>
          </div>
        </Section>
      ) : null}
    </>
  );
}
