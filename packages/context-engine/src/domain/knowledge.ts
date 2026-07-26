import type { EvidenceAnchor } from "./evidence.js";
import { canonicalJson, fingerprint, normalizeIsoTime, normalizeRepository, stableId } from "./fingerprint.js";

export const knowledgeDocumentKinds = [
  "architecture",
  "component",
  "feature",
  "decision",
  "change_summary",
  "incident",
  "issue_explanation",
  "ownership",
  "runbook",
  "glossary"
] as const;

export type KnowledgeDocumentKind = (typeof knowledgeDocumentKinds)[number];

export interface KnowledgeScope {
  ref: string;
  commitSha: string;
  paths: string[];
  symbols: string[];
  pullRequests: string[];
  issues: string[];
}

export interface KnowledgeEvidenceCitation {
  id: string;
  revisionId: string;
  ordinal: number;
  claim: string;
  anchor: EvidenceAnchor;
}

export interface KnowledgeDocumentRevision {
  id: string;
  logicalId: string;
  tenantId: string;
  repository: string;
  kind: KnowledgeDocumentKind;
  title: string;
  bodyMarkdown: string;
  summary: string;
  structuredSummary: Record<string, unknown>;
  scope: KnowledgeScope;
  evidenceFingerprint: string;
  bodyDigest: string;
  generatorName: string;
  generatorVersion: string;
  model: string;
  promptVersion: string;
  confidence: number;
  createdAt: string;
}

export function sameImmutableKnowledgeRevision(
  left: KnowledgeDocumentRevision,
  right: KnowledgeDocumentRevision
): boolean {
  const { createdAt: _leftCreatedAt, ...leftImmutable } = left;
  const { createdAt: _rightCreatedAt, ...rightImmutable } = right;
  return canonicalJson(leftImmutable) === canonicalJson(rightImmutable);
}

export function sameImmutableKnowledgeCitation(
  left: KnowledgeEvidenceCitation,
  right: KnowledgeEvidenceCitation
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export type KnowledgeRevisionEventType =
  "reviewed" | "rejected" | "invalidated" | "superseded" | "redacted" | "retained";

export interface KnowledgeRevisionEvent {
  id: string;
  revisionId: string;
  sequence: number;
  type: KnowledgeRevisionEventType;
  actorId: string;
  reason: string;
  replacementRevisionId?: string;
  createdAt: string;
}

export interface KnowledgeDocumentDraftCitation {
  claim: string;
  sourceType: EvidenceAnchor["sourceType"];
  sourceId: string;
  pathOrUrl?: string;
  startLine?: number;
  endLine?: number;
  jsonPointer?: string;
}

export interface KnowledgeDocumentDraft {
  logicalId: string;
  kind: KnowledgeDocumentKind;
  title: string;
  summary: string;
  bodyMarkdown: string;
  structuredSummary: Record<string, unknown>;
  scope: Omit<KnowledgeScope, "ref" | "commitSha">;
  confidence: number;
  citations: KnowledgeDocumentDraftCitation[];
}

export interface KnowledgeGenerationOutput {
  documents: KnowledgeDocumentDraft[];
}

export interface DerivationRun {
  id: string;
  tenantId: string;
  repository: string;
  checkpointId: string;
  cacheKey: string;
  focusFingerprint: string;
  generatorName: string;
  generatorVersion: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  rawOutputs: unknown[];
  status: "succeeded" | "failed";
  diagnostics: string[];
  revisionIds: string[];
  createdAt: string;
}

const logicalIdPatterns: Record<KnowledgeDocumentKind, RegExp> = {
  architecture: /^repository:[a-z0-9_.-]+\/[a-z0-9_.-]+:architecture$/,
  component: /^component:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/-]*$/,
  feature: /^feature:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/-]*$/,
  decision: /^decision:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/#-]*$/,
  change_summary: /^change:[a-z0-9_.-]+\/[a-z0-9_.-]+:[0-9a-f]{40}$/,
  incident: /^incident:[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/#-]*$/,
  issue_explanation: /^issue:[a-z0-9_.-]+:[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9][0-9]*$/,
  ownership: /^ownership:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/@-]*$/,
  runbook: /^runbook:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/-]*$/,
  glossary: /^glossary:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/-]*$/
};

export function validateLogicalId(kind: KnowledgeDocumentKind, logicalId: string, repository: string): void {
  const normalized = logicalId.trim().toLowerCase();
  const normalizedRepository = normalizeRepository(repository);
  if (!logicalIdPatterns[kind].test(normalized)) throw new Error(`Invalid ${kind} logicalId`);
  if (kind === "architecture" && normalized !== `repository:${normalizedRepository}:architecture`) {
    throw new Error("Architecture logical ID does not match repository");
  }
  if (kind === "issue_explanation") {
    const issue = /^issue:[a-z0-9_.-]+:([a-z0-9_.-]+\/[a-z0-9_.-]+)#[1-9][0-9]*$/.exec(normalized);
    if (issue?.[1] !== normalizedRepository) throw new Error("Issue logical ID does not match repository");
  }
  if (kind !== "incident" && kind !== "issue_explanation" && !normalized.includes(`:${normalizedRepository}:`)) {
    throw new Error("Logical ID does not match repository");
  }
}

export function createKnowledgeRevision(
  input: Omit<KnowledgeDocumentRevision, "id" | "bodyDigest">
): KnowledgeDocumentRevision {
  validateLogicalId(input.kind, input.logicalId, input.repository);
  if (input.title.trim() === "" || input.summary.trim() === "" || input.bodyMarkdown.trim() === "") {
    throw new Error("Knowledge title, summary, and body are required");
  }
  if (input.confidence < 0 || input.confidence > 1) throw new Error("Knowledge confidence must be between 0 and 1");
  const bodyDigest = fingerprint(input.bodyMarkdown);
  const logicalId = input.logicalId.trim().toLowerCase();
  return {
    ...input,
    logicalId,
    repository: normalizeRepository(input.repository),
    createdAt: normalizeIsoTime(input.createdAt),
    bodyDigest,
    id: stableId("kr", {
      logicalId,
      evidenceFingerprint: input.evidenceFingerprint,
      generatorVersion: input.generatorVersion,
      bodyDigest
    })
  };
}

export function createKnowledgeCitation(
  revisionId: string,
  ordinal: number,
  claim: string,
  anchor: EvidenceAnchor
): KnowledgeEvidenceCitation {
  if (claim.trim() === "") throw new Error("Citation claim is required");
  return {
    id: stableId("kc", { revisionId, ordinal, claim, anchor }),
    revisionId,
    ordinal,
    claim: claim.trim(),
    anchor
  };
}

export function requiresKnowledgeReview(kind: KnowledgeDocumentKind): boolean {
  return kind === "incident" || kind === "ownership";
}
