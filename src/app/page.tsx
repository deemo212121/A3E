import Link from "next/link";

import { BUTTON_VARIANTS } from "@/components/ui/primitives";

export default function Home() {
  return (
    <main id="main" className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-16">
      <h1 className="text-2xl font-semibold">A3E Accounting Platform</h1>
      <p className="text-[var(--muted)]">
        Secure workspace for the accounting firm and its client businesses. Access is by invitation
        only.
      </p>
      <p>
        <Link href="/app" className={BUTTON_VARIANTS.primary}>
          Sign in
        </Link>
      </p>
    </main>
  );
}
