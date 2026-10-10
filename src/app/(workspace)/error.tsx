"use client"; // Error boundaries must be Client Components

/** Errors inside the workspace keep the shell; details stay in server logs. */
export default function WorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col gap-3 py-10">
      <h1 className="text-xl font-semibold">Something went wrong loading this page</h1>
      <p>Please try again. If the problem continues, contact support.</p>
      {error.digest ? (
        <p className="text-sm text-[var(--muted)]">
          Reference: <code>{error.digest}</code>
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => retry()}
        className="w-fit rounded-md border border-[var(--border)] px-3 py-1.5"
      >
        Try again
      </button>
    </div>
  );
}
