import type { ReactNode } from "react";

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  /** Visually hide the header (still read by screen readers), e.g. for actions. */
  srOnlyHeader?: boolean;
  /** "num" right-aligns with tabular figures; "nowrap" keeps dates on one line. */
  kind?: "text" | "num" | "nowrap";
  /** Hide this column in the phone card layout (keep it on wider screens). */
  hideOnMobile?: boolean;
  className?: string;
}

/**
 * Consistent, accessible table: <caption>, scoped headers, and an empty state.
 * Below 768px every row turns into a card with labelled fields (globals.css
 * `.rtable`), so nothing is cut off on phones.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty = "Nothing to show yet.",
}: {
  caption: string;
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-[var(--border)] p-4 text-sm text-[var(--muted)]">
        {empty}
      </p>
    );
  }
  const kindClass = (c: Column<T>) =>
    c.kind === "num" ? "num" : c.kind === "nowrap" ? "nowrap" : "";
  return (
    <div className="rtable w-full overflow-x-auto rounded-md border border-[var(--border)]">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-[var(--surface)]">
          <tr>
            {columns.map((c) => (
              <th
                key={c.header}
                scope="col"
                className={`border-b border-[var(--border)] px-3 py-2 text-left font-medium text-[var(--muted)] ${c.kind === "num" ? "text-right" : ""} ${c.className ?? ""}`}
              >
                {c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-[var(--surface-raised)]">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--surface)]"
            >
              {columns.map((c) => (
                <td
                  key={c.header}
                  data-label={c.srOnlyHeader ? "" : c.header}
                  className={`px-3 py-2 align-top ${kindClass(c)} ${c.hideOnMobile ? "mobile-hide" : ""} ${c.className ?? ""}`}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
