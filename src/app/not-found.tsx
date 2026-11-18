import Link from "next/link";

export default function NotFound() {
  return (
    <div className="wrap page">
      <div className="empty">
        <p className="label">404 · not on the manifest</p>
        <h1>Nothing here</h1>
        <p>This post isn&apos;t in the export, or the link is wrong.</p>
        <p>
          <Link className="btn" href="/">
            Back to the manifest
          </Link>
        </p>
      </div>
    </div>
  );
}
