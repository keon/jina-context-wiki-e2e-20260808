import type { EvidenceAuthorityClass, EvidenceSourceType } from "../domain/evidence.js";
import { canonicalJson, fingerprint } from "../domain/fingerprint.js";

export interface ProviderObservationInput {
  sourceType: Extract<EvidenceSourceType, "observation" | "pull_request" | "issue" | "document">;
  sourceId: string;
  title: string;
  payload: unknown;
  pathOrUrl?: string;
  observedAt: string;
  authorityClass?: EvidenceAuthorityClass;
  metadata?: Record<string, unknown>;
}

export interface NormalizedProviderObservation extends ProviderObservationInput {
  body: string;
  contentDigest: string;
  authorityClass: EvidenceAuthorityClass;
  metadata: Record<string, unknown>;
}

export function normalizeProviderObservation(input: ProviderObservationInput): NormalizedProviderObservation {
  if (input.sourceId.trim() === "") throw new Error("Provider sourceId is required");
  const body = typeof input.payload === "string" ? input.payload : canonicalJson(input.payload);
  return {
    ...input,
    body,
    contentDigest: fingerprint(body),
    authorityClass: input.authorityClass ?? (input.sourceType === "document" ? "human_document" : "provider_state"),
    metadata: input.metadata ?? {}
  };
}
