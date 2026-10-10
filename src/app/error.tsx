"use client"; // Error boundaries must be Client Components

/**
 * Route-level error boundary. Shows a generic message only; details stay in
 * server logs. `error.digest` correlates the user's report with server logs.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="mx-auto flex max-w-xl flex-1 flex-col gap-4 px-4 py-16">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p>Please try again. If the problem continues, contact support.</p>
      {error.digest ? (
        <p className="text-sm text-[var(--muted)]">
          Reference: <code>{error.digest}</code>
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => retry()}
        className="w-fit rounded border border-[var(--border)] px-4 py-2"
      >
        Try again
      </button>
    </main>
  );
}
