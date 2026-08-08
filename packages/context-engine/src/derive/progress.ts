/**
 * Validates the extensionless, repository-context-relative identity used by
 * provisional page checkpoints.
 *
 * These paths cross a worker/API trust boundary and are later joined onto a
 * writable derivation directory. Keeping the validation next to the shared
 * progress contract prevents a forged checkpoint from becoming a traversal on
 * retry. Hidden segments are excluded because output collectors deliberately
 * reserve them for private control-plane state.
 */
export function derivationProgressDocumentPath(value: string): string {
  const candidate = value.trim().replaceAll("\\", "/");
  const segments = candidate.split("/");
  if (
    candidate.length === 0 ||
    candidate.length > 500 ||
    candidate.startsWith("/") ||
    candidate.endsWith(".md") ||
    candidate.includes("\0") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw new Error("derivation progress documentPath must be a safe extensionless relative path");
  }
  return candidate;
}
