"use client"; // Error boundaries must be Client Components

/** Last-resort boundary for errors in the root layout. Must render html/body. */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1rem", maxWidth: 640 }}>
        <title>Error</title>
        <h1>Something went wrong</h1>
        <p>Please try again. If the problem continues, contact support.</p>
        {error.digest ? (
          <p>
            Reference: <code>{error.digest}</code>
          </p>
        ) : null}
        <button type="button" onClick={() => retry()}>
          Try again
        </button>
      </body>
    </html>
  );
}
