"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Secondary (tab-style) navigation with aria-current. Items are policy-filtered by the server. */
export function SubNav({
  label,
  items,
}: {
  label: string;
  items: { href: string; label: string }[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="mb-6 overflow-x-auto border-b border-[var(--border)]">
      <ul className="flex gap-1">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`inline-block border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
                  active ? "border-[var(--accent)] font-medium" : "border-transparent"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
