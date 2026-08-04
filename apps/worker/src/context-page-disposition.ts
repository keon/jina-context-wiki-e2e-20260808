export type ContextPagePublicationDisposition =
  | { readonly status: "accepted" | "retained_stale"; readonly pageArtifact: unknown }
  | { readonly status: "omitted"; readonly reasonCode: string };

export function contextPagePublicationDisposition(
  result: Record<string, unknown>
): ContextPagePublicationDisposition {
  const disposition = result.disposition;
  if (!disposition || typeof disposition !== "object" || Array.isArray(disposition)) {
    throw new Error("Context page dependency disposition is missing");
  }
  const value = disposition as Record<string, unknown>;
  const status = value.status;
  if (status === "omitted") {
    if (typeof value.reasonCode !== "string" || value.reasonCode.length === 0) {
      throw new Error("Omitted Context page dependency reasonCode is missing");
    }
    return { status, reasonCode: value.reasonCode };
  }
  if (status === "accepted" || status === "retained_stale") {
    if (value.pageArtifact === undefined) {
      throw new Error("Context page dependency pageArtifact is missing");
    }
    return { status, pageArtifact: value.pageArtifact };
  }
  throw new Error("Context page dependency disposition status is invalid");
}
