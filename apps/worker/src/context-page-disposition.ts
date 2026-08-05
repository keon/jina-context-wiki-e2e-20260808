export type ContextPagePublicationDisposition =
  | { readonly status: "accepted" | "retained_stale"; readonly pageArtifact: unknown }
  | { readonly status: "omitted"; readonly reasonCode: string };

export type ContextPageOmissionResolution =
  { readonly status: "omit_new_page" } | { readonly status: "retain_prior_page" };

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

/**
 * A failed new page can be omitted from a release. An existing page cannot:
 * incremental publication must keep the last certified bytes rather than
 * silently deleting established Context when a proposed revision fails audit.
 */
export function resolveContextPageOmission(input: {
  readonly plannedChange: "add" | "retain" | "revise";
  readonly hasPriorPage: boolean;
}): ContextPageOmissionResolution {
  if (input.plannedChange === "add") return { status: "omit_new_page" };
  if (!input.hasPriorPage) {
    throw new Error(`Omitted ${input.plannedChange} Context page has no certified prior page`);
  }
  return { status: "retain_prior_page" };
}
