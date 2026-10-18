"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import { BUTTON_VARIANTS } from "@/components/ui/primitives";
import type { TourStep } from "@/lib/tour/steps";

const STAGES = ["Set up", "Collect", "Record", "Report", "Tax", "File", "Run the firm"] as const;

/**
 * Step-by-step guide through the whole process. Presentation only: links were
 * already filtered by the route policy on the server.
 */
export function TourGuide({
  steps,
  roleLabels,
}: {
  steps: TourStep[];
  roleLabels: Record<string, string>;
}) {
  const [onlyMine, setOnlyMine] = useState(false);
  const [index, setIndex] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const visible = useMemo(
    () => (onlyMine ? steps.filter((s) => s.mine) : steps),
    [onlyMine, steps],
  );
  const current = visible[Math.min(index, visible.length - 1)];

  const go = (next: number, focus = true) => {
    const bounded = Math.max(0, Math.min(next, visible.length - 1));
    setIndex(bounded);
    if (focus) requestAnimationFrame(() => headingRef.current?.focus());
  };

  if (!current) {
    return <p className="text-sm text-[var(--muted)]">No steps involve your role yet.</p>;
  }
  const position = visible.indexOf(current);
  const percent = Math.round(((position + 1) / visible.length) * 100);

  return (
    <div
      className="flex flex-col gap-4"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === "INPUT") return;
        if (e.key === "ArrowRight") go(position + 1);
        if (e.key === "ArrowLeft") go(position - 1);
      }}
    >
      {/* The process at a glance */}
      <ol aria-label="Process stages" className="flex flex-wrap items-center gap-1 text-xs">
        {STAGES.map((stage, i) => {
          const active = current.stage === stage;
          return (
            <li key={stage} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => go(visible.findIndex((s) => s.stage === stage))}
                disabled={!visible.some((s) => s.stage === stage)}
                aria-current={active ? "step" : undefined}
                className={`rounded-full border px-2.5 py-1 disabled:opacity-40 ${
                  active
                    ? "border-[var(--accent)] bg-[var(--info-bg)] font-semibold text-[var(--accent)]"
                    : "border-[var(--border)]"
                }`}
              >
                {stage}
              </button>
              {i < STAGES.length - 1 ? <span aria-hidden>→</span> : null}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-[12rem] flex-1 items-center gap-2 text-sm">
          <span className="whitespace-nowrap">
            Step {position + 1} of {visible.length}
          </span>
          <div
            className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface)]"
            role="progressbar"
            aria-label="Tour progress"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full bg-[var(--accent)]" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyMine}
            onChange={(e) => {
              setOnlyMine(e.target.checked);
              setIndex(0);
            }}
          />
          Only the steps I take part in
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <nav aria-label="Tour steps" className="hidden lg:block">
          <ol className="flex flex-col gap-1 text-sm">
            {visible.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={i === position ? "step" : undefined}
                  className={`w-full rounded-md px-2 py-1.5 text-left ${
                    i === position ? "bg-[var(--info-bg)] font-medium text-[var(--accent)]" : ""
                  }`}
                >
                  {s.title}
                  {s.mine ? (
                    <span className="ml-1 text-xs text-[var(--success)]" aria-label="(your part)">
                      ●
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section
          aria-labelledby="tour-step-title"
          className="rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4 shadow-[var(--shadow)] sm:p-5"
        >
          <p className="text-xs tracking-wide text-[var(--muted)] uppercase">{current.stage}</p>
          <h2
            id="tour-step-title"
            ref={headingRef}
            tabIndex={-1}
            className="mt-1 text-xl font-semibold outline-none"
          >
            {current.title}
          </h2>
          <p className="mt-2">{current.summary}</p>

          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-[var(--muted)]">Who:</span>
            {current.who.map((r) => (
              <span key={r} className="rounded-full border border-[var(--border)] px-2 py-0.5">
                {roleLabels[r] ?? r}
              </span>
            ))}
            {current.mine ? (
              <span className="rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-[var(--success)]">
                Your part
              </span>
            ) : null}
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="font-medium">What happens</h3>
              <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">
                {current.happens.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ol>
            </div>
            <div>
              <h3 className="font-medium">Safeguards</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {current.safeguards.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </div>

          {current.links.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {current.links.map((l) => (
                <Link key={l.href} href={l.href} className={BUTTON_VARIANTS.secondary}>
                  Open {l.label} →
                </Link>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-xs text-[var(--muted)]">
              This step is done by other roles; there is no page for you to open here.
            </p>
          )}

          <div className="mt-6 flex flex-wrap justify-between gap-2 border-t border-[var(--border)] pt-4">
            <button
              type="button"
              onClick={() => go(position - 1)}
              disabled={position === 0}
              className={BUTTON_VARIANTS.secondary}
            >
              ← Back
            </button>
            {position < visible.length - 1 ? (
              <button
                type="button"
                onClick={() => go(position + 1)}
                className={BUTTON_VARIANTS.primary}
              >
                Next: {visible[position + 1].title.replace(/^\d+\.\s*/, "")} →
              </button>
            ) : (
              <button type="button" onClick={() => go(0)} className={BUTTON_VARIANTS.primary}>
                Start again
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">
            Tip: use the ← and → keys to move between steps.
          </p>
        </section>
      </div>
    </div>
  );
}
