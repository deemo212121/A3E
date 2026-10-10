import Link from "next/link";
import type { ReactNode } from "react";

import { signOutAction } from "@/features/auth/actions";
import type { NavSection } from "@/lib/access/route-policy";

import { MobileNav, NavLinks, WorkspaceLabel } from "./nav-client";

/**
 * Responsive application shell: skip link, header (workspace, notifications,
 * user menu), policy-filtered sidebar navigation, and the main landmark.
 * Navigation visibility is NOT a security control.
 */
export function AppShell({
  sections,
  user,
  notificationCount,
  children,
}: {
  sections: NavSection[];
  user: { name: string; email: string; roleLabel: string | null };
  notificationCount: number;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-[var(--surface-raised)] focus:p-2"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-raised)] px-4 shadow-[var(--shadow)]">
        <div className="flex items-center gap-3">
          <Link href="/app" className="flex items-center gap-2 font-semibold">
            <span
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-md bg-[var(--accent)] text-xs text-[var(--accent-foreground)]"
            >
              A3
            </span>
            <span>A3E</span>
          </Link>
          <WorkspaceLabel />
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/invitations"
            className="relative rounded-md border border-[var(--border)] px-2 py-1 text-sm"
            aria-label={
              notificationCount > 0
                ? `Notifications: ${notificationCount} pending invitation${notificationCount === 1 ? "" : "s"}`
                : "Notifications: none"
            }
          >
            <span aria-hidden>🔔</span>
            {notificationCount > 0 ? (
              <span
                aria-hidden
                className="absolute -top-2 -right-2 rounded-full bg-[var(--danger)] px-1.5 text-xs text-white"
              >
                {notificationCount}
              </span>
            ) : null}
          </Link>
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-md border border-[var(--border)] px-2 py-1 text-sm">
              <span className="sr-only">Account menu for </span>
              {user.name || user.email}
            </summary>
            <div className="absolute right-0 z-40 mt-2 w-64 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-3 text-sm shadow-lg">
              <p className="font-medium">{user.name || user.email}</p>
              <p className="text-xs break-all text-[var(--muted)]">{user.email}</p>
              {user.roleLabel ? <p className="mt-1 text-xs">{user.roleLabel}</p> : null}
              <div className="mt-3 flex flex-col gap-2">
                <Link href="/account" className="underline">
                  My account
                </Link>
                <form action={signOutAction}>
                  <button type="submit" className="underline">
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </details>
          <MobileNav sections={sections} />
        </div>
      </header>
      <div className="flex flex-1">
        <nav
          aria-label="Main"
          className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-[var(--sidebar-width)] shrink-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface-raised)] p-3 md:block"
        >
          <NavLinks sections={sections} />
        </nav>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function ShellSkeleton({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="h-14 border-b border-[var(--border)]" />
      <main id="main" className="flex-1 px-4 py-6 md:px-8">
        {children}
      </main>
    </div>
  );
}
