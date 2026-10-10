import type { ReactNode } from "react";

/**
 * Shared presentational components live in `src/components/ui`.
 * They must stay free of data access and business logic, and must not import
 * from `src/server` or server-only modules (enforced by ESLint).
 */
export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="mb-2 text-lg font-medium">{title}</h2>
      <div className="text-[var(--muted)]">{children}</div>
    </section>
  );
}
