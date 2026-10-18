import Link from "next/link";

import { Alert, BUTTON_VARIANTS } from "@/components/ui/primitives";
import { toText } from "@/lib/reports/statements";
import type { BuiltReport, ReportKey, ReportOptions } from "@/server/reports/build";
import { REPORTS } from "@/server/reports/build";

const fmt = (v: bigint | null, peso: boolean) => {
  if (v === null) return "—";
  const t = toText(v);
  const negative = t.startsWith("-");
  const [whole, frac] = t.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = peso ? grouped : `${grouped}.${frac}`;
  return negative ? `(${body})` : body;
};

/** Report table with drill-down links from account lines. */
export function ReportView({
  report,
  options,
  drillHref,
}: {
  report: BuiltReport;
  options: ReportOptions;
  /** link for an account line, or null where drill-down is not offered */
  drillHref: ((accountId: string) => string) | null;
}) {
  const peso = options.rounding === "peso";
  return (
    <div className="flex flex-col gap-3">
      {report.openPeriods > 0 ? (
        <Alert tone="warning" title="Preliminary">
          {report.openPeriods} accounting period(s) in this range are still open; figures can still
          change.
        </Alert>
      ) : null}
      {report.checks.map((c) => (
        <Alert key={c.label} tone={c.ok ? "success" : "danger"}>
          {c.ok ? "✓" : "✗"} {c.label}
        </Alert>
      ))}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm tabular-nums">
          <caption className="mb-2 text-left">
            <span className="font-semibold">{report.title}</span>{" "}
            <span className="text-[var(--muted)]">· {report.subtitle}</span>
          </caption>
          <thead>
            <tr className="text-[var(--muted)]">
              <th className="py-1 text-left font-medium">
                <span className="sr-only">Line</span>
              </th>
              {report.table.columns.map((c) => (
                <th key={c} className="py-1 text-right font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.table.rows.map((r, i) => (
              <tr
                key={i}
                className={
                  r.kind === "heading"
                    ? ""
                    : r.kind === "total"
                      ? "border-t-2 border-[var(--border)] font-semibold"
                      : r.kind === "subtotal"
                        ? "border-t border-[var(--border)] font-medium"
                        : "border-t border-[var(--border)]"
                }
              >
                <td
                  className={`py-1.5 ${r.kind === "heading" ? "pt-4 font-semibold" : r.kind === "line" ? "pl-3" : ""}`}
                >
                  {r.accountId && drillHref ? (
                    <Link className="underline decoration-dotted" href={drillHref(r.accountId)}>
                      {r.label}
                    </Link>
                  ) : (
                    r.label
                  )}
                </td>
                {r.kind === "heading"
                  ? report.table.columns.map((c) => <td key={c} />)
                  : r.values.map((v, k) => (
                      <td key={k} className="py-1.5 text-right">
                        {fmt(v, peso)}
                      </td>
                    ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.notes.map((n) => (
        <p key={n} className="text-xs text-[var(--muted)]">
          {n}
        </p>
      ))}
      <p className="text-xs text-[var(--muted)]">
        Source: posted journal entries only (drafts and submitted entries are excluded; a reversal
        nets its original to zero). Negative amounts are shown in parentheses.
      </p>
    </div>
  );
}

/** GET filter form (no client JS needed). */
export function ReportFilters({
  options,
  reports,
  maxDate,
}: {
  options: ReportOptions;
  reports: ReportKey[];
  maxDate?: string;
}) {
  const input =
    "rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-sm";
  return (
    <form method="get" className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
      <label className="flex flex-col gap-1 text-sm">
        <span>Report</span>
        <select name="report" defaultValue={options.report} className={input}>
          {reports.map((r) => (
            <option key={r} value={r}>
              {REPORTS[r]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>From (period reports)</span>
        <input
          type="date"
          name="from"
          defaultValue={options.from}
          max={maxDate}
          className={input}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>To / as of</span>
        <input type="date" name="to" defaultValue={options.to} max={maxDate} className={input} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>Compare with</span>
        <select name="compare" defaultValue={options.compare} className={input}>
          <option value="none">No comparison</option>
          <option value="previous">Previous period</option>
          <option value="prior_year">Same period last year</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>Rounding</span>
        <select name="rounding" defaultValue={options.rounding} className={input}>
          <option value="centavo">Centavos</option>
          <option value="peso">Whole pesos</option>
        </select>
      </label>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input type="checkbox" name="zero" value="1" defaultChecked={options.includeZero} /> Show
        zero balances (trial balance)
      </label>
      <button type="submit" className={BUTTON_VARIANTS.secondary}>
        Show
      </button>
    </form>
  );
}

export function exportQuery(o: ReportOptions): string {
  const q = new URLSearchParams({
    report: o.report,
    from: o.from,
    to: o.to,
    compare: o.compare,
    rounding: o.rounding,
    ...(o.includeZero ? { zero: "1" } : {}),
  });
  return q.toString();
}
