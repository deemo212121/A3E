"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

import { BUTTON_VARIANTS } from "@/components/ui/primitives";
import type { GuidedStep } from "@/lib/tour/guided";

/*
 * Guided tour state lives in this browser only (sessionStorage): which steps
 * and where you are. It holds page paths and texts, never data. Pages still
 * run their own access checks, so a tampered value can only open pages the
 * user may open anyway.
 */
const KEY = "a3e.guidedTour";
const EVENT = "a3e-guided-tour";

interface TourState {
  steps: GuidedStep[];
  index: number;
}

function read(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function write(state: TourState | null) {
  try {
    if (state) window.sessionStorage.setItem(KEY, JSON.stringify(state));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the tour simply does not persist
  }
  window.dispatchEvent(new Event(EVENT));
}
function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}
function parse(raw: string | null): TourState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as TourState;
    return Array.isArray(s.steps) && s.steps.length > 0 ? s : null;
  } catch {
    return null;
  }
}

/** Starts the guided tour and opens its first page. */
export function StartGuidedTourButton({
  steps,
  label = "Start the guided tour",
}: {
  steps: GuidedStep[];
  label?: string;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={BUTTON_VARIANTS.primary}
      onClick={() => {
        write({ steps, index: 0 });
        router.push(steps[0].path ?? "/tour");
      }}
    >
      {label}
    </button>
  );
}

/** The floating guide shown on every page while a guided tour is running. */
export function GuidedTourPanel() {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const state = parse(raw);
  const router = useRouter();
  const pathname = usePathname();
  const step = state ? state.steps[Math.min(state.index, state.steps.length - 1)] : null;
  const onPage = step?.path ? pathname === step.path : true;

  // Highlight the section this step is about (DOM only; no React state). The
  // page streams in after navigation, so wait (up to 8 s) for its heading.
  useEffect(() => {
    const focus = step?.focus;
    if (!focus || !onPage) return;
    let target: Element | null = null;
    const apply = () => {
      const heading = Array.from(document.querySelectorAll("main h2")).find((h) =>
        (h.textContent ?? "").trim().startsWith(focus),
      );
      if (!heading) return false;
      target = heading.closest("section") ?? heading;
      target.classList.add("tour-highlight");
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    };
    if (apply()) return () => target?.classList.remove("tour-highlight");
    const observer = new MutationObserver(() => {
      if (apply()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 8000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      target?.classList.remove("tour-highlight");
    };
  }, [step?.focus, onPage, pathname]);

  if (!state || !step) return null;
  const i = state.steps.indexOf(step);
  const go = (next: number) => {
    const n = Math.max(0, Math.min(next, state.steps.length - 1));
    write({ ...state, index: n });
    const p = state.steps[n].path;
    if (p && p !== pathname) router.push(p);
  };

  return (
    <aside
      aria-label="Guided tour"
      className="fixed right-3 bottom-3 left-3 z-50 max-h-[60vh] overflow-y-auto rounded-xl border-2 border-[var(--accent)] bg-[var(--surface-raised)] p-4 shadow-lg sm:left-auto sm:w-[26rem]"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-[var(--muted)]">
          🧭 Guided tour · step {i + 1} of {state.steps.length}
        </p>
        <button
          type="button"
          onClick={() => write(null)}
          className="text-xs underline"
          aria-label="End the guided tour"
        >
          End tour
        </button>
      </div>
      <h2 className="mt-1 font-semibold">{step.title}</h2>
      <p className="mt-2 text-sm">{step.text}</p>
      {step.tryIt ? (
        <p className="mt-2 rounded-md bg-[var(--info-bg)] p-2 text-sm">
          <strong>Try it:</strong> {step.tryIt}
        </p>
      ) : null}
      {!onPage && step.path ? (
        <button
          type="button"
          className={`${BUTTON_VARIANTS.secondary} mt-3`}
          onClick={() => router.push(step.path!)}
        >
          Go to this step&apos;s page
        </button>
      ) : null}
      <div className="mt-3 flex justify-between gap-2">
        <button
          type="button"
          onClick={() => go(i - 1)}
          disabled={i === 0}
          className={BUTTON_VARIANTS.secondary}
        >
          ← Back
        </button>
        {i < state.steps.length - 1 ? (
          <button type="button" onClick={() => go(i + 1)} className={BUTTON_VARIANTS.primary}>
            Next →
          </button>
        ) : (
          <button type="button" onClick={() => write(null)} className={BUTTON_VARIANTS.primary}>
            Finish
          </button>
        )}
      </div>
    </aside>
  );
}
