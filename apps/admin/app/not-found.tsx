import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty-state">
      <p>That context document does not exist (or is no longer eligible).</p>
      <p>
        <Link href="/">Back to context administration</Link>
      </p>
    </div>
  );
}
