"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import type { NavSection } from "@/lib/access/route-policy";

function matches(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/app" && pathname.startsWith(`${href}/`));
}

/** The single nav href that best matches the current path (longest prefix wins). */
function bestMatch(pathname: string, sections: NavSection[]): string | undefined {
  return sections
    .flatMap((s) => s.items.map((i) => i.href))
    .filter((href) => matches(pathname, href))
    .sort((a, b) => b.length - a.length)[0];
}

/** Sidebar links with aria-current. Items come from the server (policy-filtered). */
export function NavLinks({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const activeHref = bestMatch(pathname, sections);
  return (
    <>
      {sections.map((section) => (
        <div key={section.id} className="mb-5">
          <p className="mb-1 px-2 text-xs font-semibold tracking-wide text-[var(--muted)] uppercase">
            {section.label}
          </p>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = item.href === activeHref;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    data-nav-route={item.route}
                    className={`block rounded-md px-2 py-1.5 text-sm ${
                      active
                        ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                        : "hover:bg-[var(--surface)]"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

/** Mobile disclosure for the sidebar; closes on navigation. */
export function MobileNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  // Remember the page the menu was opened on: navigating elsewhere closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (next: (v: boolean) => boolean) => setOpenOn(next(open) ? pathname : null);
  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
      >
        {open ? "Close menu" : "Menu"}
      </button>
      {open ? (
        <nav
          id="mobile-nav"
          aria-label="Main"
          className="absolute top-14 right-0 left-0 z-40 max-h-[80vh] overflow-y-auto border-b border-[var(--border)] bg-[var(--background)] p-4"
        >
          <NavLinks sections={sections} />
        </nav>
      ) : null}
    </div>
  );
}

const AREA_LABELS: [string, string][] = [
  ["/portal", "Client portal"],
  ["/staff", "Accounting staff portal"],
  ["/review", "Reviewer / manager workspace"],
  ["/admin", "Firm administration"],
  ["/account", "My account"],
  ["/invitations", "My account"],
];

/** Shows which workspace the user is in (distinct experiences per area). */
export function WorkspaceLabel() {
  const pathname = usePathname();
  const label = AREA_LABELS.find(([p]) => pathname === p || pathname.startsWith(`${p}/`))?.[1];
  return label ? (
    <span data-workspace={label} className="hidden text-sm text-[var(--muted)] sm:inline">
      {label}
    </span>
  ) : null;
}
