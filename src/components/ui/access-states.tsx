import Link from "next/link";

/**
 * Rendered when the server-side guard denies a route. The `data-access`
 * marker is asserted by the route-access tests.
 */
export function AccessDenied() {
  return (
    <div data-access="denied" className="flex flex-col gap-3 py-10">
      <h1 className="text-2xl font-semibold">You don&apos;t have access to this page</h1>
      <p className="text-[var(--muted)]">
        If you believe you should, ask your accounting firm&apos;s administrator.
      </p>
      <p>
        <Link href="/app" className="underline">
          Go to your home page
        </Link>
      </p>
    </div>
  );
}

export function DeniedState({ reason }: { reason: "forbidden" | "not_found" }) {
  return reason === "not_found" ? <NotFoundState /> : <AccessDenied />;
}

/**
 * Used for client-scoped pages: never reveals whether a client exists.
 * `marker` distinguishes a guard decision ("not-found") from the app-wide
 * not-found boundary ("unknown-page"), which Next.js embeds in every page payload.
 */
export function NotFoundState({ marker = "not-found" }: { marker?: string }) {
  return (
    <div data-access={marker} className="flex flex-col gap-3 py-10">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-[var(--muted)]">This page does not exist or is not available to you.</p>
      <p>
        <Link href="/app" className="underline">
          Go to your home page
        </Link>
      </p>
    </div>
  );
}
