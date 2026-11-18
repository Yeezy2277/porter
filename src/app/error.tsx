"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="wrap page">
      <div className="empty" role="alert">
        <p className="label">Error</p>
        <h1>This page didn&apos;t load</h1>
        <p>
          Something failed while converting or rendering. Try again; if it keeps failing, /api/health shows what is configured.
          {error.digest ? ` Reference: ${error.digest}.` : ""}
        </p>
        <p>
          <button className="btn" onClick={reset}>
            Try again
          </button>
        </p>
      </div>
    </div>
  );
}
