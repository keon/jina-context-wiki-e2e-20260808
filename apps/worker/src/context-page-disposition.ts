export type ContextPagePublicationDisposition =
  | { readonly status: "accepted" | "retained_stale"; readonly pageArtifact: unknown }
  | { readonly status: "omitted"; readonly reasonCode: string };

export type UnsupportedContextPageFallback<TPriorPage> =
  | {
      readonly status: "retained_stale";
      readonly reasonCode: "unsupported_core_claims";
      readonly priorPage: TPriorPage;
    }
  | { readonly status: "omitted"; readonly reasonCode: "unsupported_core_claims" };

/**
 * A new unsupported page can be withheld. An existing page cannot disappear
 * from an incremental release merely because its replacement failed audit, so
 * revisions fall back to the previously certified page instead.
 */
export function unsupportedContextPageFallback<TPriorPage>(
  operation: string,
  priorPage: TPriorPage | undefined
): UnsupportedContextPageFallback<TPriorPage> {
  if (operation === "add") {
    return { status: "omitted", reasonCode: "unsupported_core_claims" };
  }
  if (operation !== "revise") {
    throw new Error(`Unsupported Context page fallback does not accept ${operation}`);
  }
  if (!priorPage) {
    throw new Error("Revised Context page fallback requires a prior certified page");
  }
  return { status: "retained_stale", reasonCode: "unsupported_core_claims", priorPage };
}

export function contextPagePublicationDisposition(result: Record<string, unknown>): ContextPagePublicationDisposition {
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
