import Link from "next/link";
import type { ReactNode } from "react";

/*
 * Shared presentational primitives (server-safe, no data access).
 * Accessibility: semantic elements, visible focus (globals.css), ARIA roles
 * for status/alert content.
 */

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50";
export const BUTTON_VARIANTS = {
  primary: `${BUTTON_BASE} bg-[var(--accent)] text-[var(--accent-foreground)]`,
  secondary: `${BUTTON_BASE} border border-[var(--border)] bg-[var(--surface-raised)]`,
  danger: `${BUTTON_BASE} border border-[var(--danger)] text-[var(--danger)]`,
} as const;
export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

export function LinkButton({
  href,
  children,
  variant = "secondary",
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
}) {
  return (
    <Link href={href} className={BUTTON_VARIANTS[variant]}>
      {children}
    </Link>
  );
}

const BADGE_TONES = {
  neutral: "border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]",
  info: "border-transparent bg-[var(--info-bg)] text-[var(--accent)]",
  success: "border-transparent bg-[var(--success-bg)] text-[var(--success)]",
  warning: "border-transparent bg-[var(--warning-bg)] text-[var(--warning)]",
  danger: "border-transparent bg-[var(--danger-bg)] text-[var(--danger)]",
} as const;

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONES;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: { href?: string; label: string }[];
}) {
  return (
    <header className="mb-6 flex flex-col gap-2">
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="text-sm text-[var(--muted)]">
          <ol className="flex flex-wrap gap-1">
            {breadcrumbs.map((b, i) => (
              <li key={`${b.label}-${i}`} className="flex gap-1">
                {b.href ? (
                  <Link href={b.href} className="underline">
                    {b.label}
                  </Link>
                ) : (
                  <span aria-current="page">{b.label}</span>
                )}
                {i < breadcrumbs.length - 1 ? <span aria-hidden>/</span> : null}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          {description ? <p className="mt-1 text-sm text-[var(--muted)]">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

const ALERT_TONES = {
  info: "border-[var(--accent)] bg-[var(--info-bg)]",
  success: "border-[var(--success)] bg-[var(--success-bg)]",
  warning: "border-[var(--warning)] bg-[var(--warning-bg)]",
  danger: "border-[var(--danger)] bg-[var(--danger-bg)]",
} as const;

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: keyof typeof ALERT_TONES;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`rounded-md border-l-4 p-3 text-sm ${ALERT_TONES[tone]}`}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-[var(--border)] p-6">
      <p className="font-medium">{title}</p>
      {children ? <div className="text-sm text-[var(--muted)]">{children}</div> : null}
      {action}
    </div>
  );
}

/** Marks synthetic demonstration content. Never shown in production. */
export function DemoNotice({ children }: { children?: ReactNode }) {
  return (
    <div
      role="note"
      data-demo="true"
      className="rounded-md border-2 border-dashed border-[var(--warning)] bg-[var(--warning-bg)] p-3 text-sm"
    >
      <p className="font-semibold">DEMO DATA: synthetic, for layout review only</p>
      {children ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-[var(--border)] ${className}`} />;
}

export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-32 w-full" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4 shadow-[var(--shadow)] sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Summary number for dashboards (e.g. "3 awaiting review"). */
export function StatCard({
  label,
  value,
  href,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: ReactNode;
  href?: string;
  tone?: "neutral" | "warning" | "success" | "danger";
  hint?: string;
}) {
  const accent = {
    neutral: "border-l-[var(--border)]",
    warning: "border-l-[var(--warning)]",
    success: "border-l-[var(--success)]",
    danger: "border-l-[var(--danger)]",
  }[tone];
  const body = (
    <>
      <p className="text-sm text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p> : null}
    </>
  );
  const cls = `block rounded-xl border border-l-4 border-[var(--border)] ${accent} bg-[var(--surface-raised)] p-4 shadow-[var(--shadow)]`;
  return href ? (
    <Link href={href} className={`${cls} hover:bg-[var(--surface)]`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/**
 * Collapsible group for secondary or destructive actions, so tables stay calm.
 * Native <details>: keyboard and screen-reader accessible without JavaScript.
 */
export function MoreActions({
  label = "More actions",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-md border border-[var(--border)] bg-[var(--surface-raised)]">
      <summary className="cursor-pointer list-none px-3 py-1.5 text-sm select-none">
        <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">
          ▸
        </span>
        {label}
      </summary>
      <div className="flex flex-col gap-4 border-t border-[var(--border)] p-3">{children}</div>
    </details>
  );
}
