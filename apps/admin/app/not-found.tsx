import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty-state">
      <p>That graph does not exist (or was superseded).</p>
      <p>
        <Link href="/">Back to all graphs</Link>
      </p>
    </div>
  );
}
