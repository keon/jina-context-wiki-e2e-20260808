import Link from "next/link";
import { EmptyState } from "@jina/ui";

export default function NotFound() {
  return (
    <EmptyState>
      <p>That context document does not exist (or is no longer eligible).</p>
      <p>
        <Link href="/">Back to context administration</Link>
      </p>
    </EmptyState>
  );
}
