import { canonicalJson } from "../domain/fingerprint.js";
import type { FocusBundle } from "./selector.js";
import { knowledgeGenerationJsonSchema } from "./schema.js";

export const KNOWLEDGE_PROMPT_VERSION = "cited-knowledge-v1";

export function buildKnowledgePrompt(bundle: FocusBundle, repairErrors: string[] = []): string {
  const evidence = bundle.items.map((item, index) => ({
    ordinal: index + 1,
    sourceType: item.anchor.sourceType,
    sourceId: item.anchor.sourceId,
    contentDigest: item.anchor.contentDigest,
    commitSha: item.anchor.commitSha,
    pathOrUrl: item.anchor.pathOrUrl,
    title: item.title,
    authorityClass: item.authorityClass,
    body: item.body
  }));
  return [
    "Produce repository knowledge documents as strict JSON.",
    "Use only the supplied evidence. Never create relation records or inferred canonical entities.",
    "Every citation.claim must be a verbatim excerpt from its selected evidence range or JSON value.",
    "Every material body paragraph must contain the exact text of at least one citation.claim.",
    "Citations must identify a supplied source and an exact, valid range or JSON pointer.",
    `Repository: ${bundle.checkpoint.repository}`,
    `Ref: ${bundle.checkpoint.ref}`,
    `Commit: ${bundle.checkpoint.commitSha}`,
    `Omitted evidence records: ${bundle.omittedCount}`,
    `Truncated evidence IDs: ${bundle.truncatedEvidenceIds.join(", ") || "none"}`,
    `Output schema: ${canonicalJson(knowledgeGenerationJsonSchema)}`,
    repairErrors.length === 0 ? "" : `Repair these validation errors only: ${canonicalJson(repairErrors)}`,
    `Evidence: ${canonicalJson(evidence)}`
  ]
    .filter(Boolean)
    .join("\n\n");
}
