export function contextPageDispositionArtifact(result: Record<string, unknown>): unknown {
  const disposition = result.disposition;
  if (!disposition || typeof disposition !== "object" || Array.isArray(disposition)) {
    throw new Error("Context page dependency disposition is missing");
  }
  const status = (disposition as Record<string, unknown>).status;
  if (status === "omitted") return undefined;
  if (status === "accepted" || status === "retained_stale") {
    return (disposition as Record<string, unknown>).pageArtifact;
  }
  throw new Error("Context page dependency disposition status is invalid");
}
