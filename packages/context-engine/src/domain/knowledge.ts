import type { EvidenceAnchor } from "./evidence.js";
import { fingerprint, normalizeIsoTime, normalizeRepository, stableId } from "./fingerprint.js";

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
  "glossary",
  // Maintenance-oriented kinds. A flow is a path through the system rather than
  // a thing in it, and a pattern is a recurring shape worth recognising before
  // repeating it — neither is expressible as a component or a feature without
  // distorting both.
  "flow",
  "pattern",
  // The kind for a document whose folder the repository chose rather than this
  // taxonomy. Context structure should fit the repository — an editor
  // has an extension host and a language server, a library has none of that —
  // so an unrecognised folder is a legitimate topic, not an error.
  "topic"
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
  /** Stable identity of the rendered public Markdown link occurrence. */
  citationId?: string;
  /** Exact public assertion span certified against this immutable anchor. */
  claimSpan?: string;
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

/** Validated knowledge bundled into a Board release publication. */
export interface KnowledgeCommit {
  run: DerivationRun;
  revisions: KnowledgeDocumentRevision[];
  citations: KnowledgeEvidenceCitation[];
}

export interface KnowledgeDocumentDraftCitation {
  claim: string;
  citationId?: string;
  claimSpan?: string;
  sourceType: EvidenceAnchor["sourceType"];
  sourceId: string;
  pathOrUrl?: string;
  startLine?: number;
  endLine?: number;
  jsonPointer?: string;
}

export interface CitedKnowledgeStatement {
  text: string;
  citationOrdinals: number[];
  confidence: number;
}

export interface KnowledgeDiagnosticSummary {
  symptoms: CitedKnowledgeStatement[];
  causes: CitedKnowledgeStatement[];
  checks: CitedKnowledgeStatement[];
  fixes: CitedKnowledgeStatement[];
}

export interface KnowledgeStructuredSummary {
  facts: CitedKnowledgeStatement[];
  questionsAnswered: CitedKnowledgeStatement[];
  diagnostics: KnowledgeDiagnosticSummary;
  claimSubject?: string;
  claimValue?: string;
  claimCitationOrdinals: number[];
}

export interface KnowledgeDocumentDraft {
  logicalId: string;
  kind: KnowledgeDocumentKind;
  title: string;
  summary: string;
  summaryCitationOrdinals: number[];
  bodyMarkdown: string;
  structuredSummary: KnowledgeStructuredSummary;
  scope: Omit<KnowledgeScope, "ref" | "commitSha">;
  confidence: number;
  citations: KnowledgeDocumentDraftCitation[];
}

export interface KnowledgeGenerationOutput {
  documents: KnowledgeDocumentDraft[];
  retiredDocuments?: {
    logicalId: string;
    reason: string;
  }[];
  /**
   * The lead agent's durable research plan.
   *
   * It is metadata about how the catalog was produced, not retrievable
   * knowledge. The host uses it to distinguish complete coverage from a useful
   * partial catalog without trusting the agent's final prose reply.
   */
  orchestration?: import("../derive/orchestration.js").ContextOrchestrationState;
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
  glossary: /^glossary:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/-]*$/,
  flow: /^flow:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/-]*$/,
  pattern: /^pattern:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/-]*$/,
  topic: /^topic:[a-z0-9_.-]+\/[a-z0-9_.-]+:[a-z0-9][a-z0-9_.:/-]*$/
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
  const revision = {
    logicalId,
    tenantId: input.tenantId,
    repository: normalizeRepository(input.repository),
    kind: input.kind,
    title: input.title,
    bodyMarkdown: input.bodyMarkdown,
    summary: input.summary,
    structuredSummary: input.structuredSummary,
    scope: input.scope,
    evidenceFingerprint: input.evidenceFingerprint,
    bodyDigest,
    generatorName: input.generatorName,
    generatorVersion: input.generatorVersion,
    model: input.model,
    promptVersion: input.promptVersion,
    confidence: input.confidence,
    createdAt: normalizeIsoTime(input.createdAt)
  };
  const { createdAt: _createdAt, ...immutableRevision } = revision;
  return { ...revision, id: stableId("kr", immutableRevision) };
}

export function createKnowledgeCitation(
  revisionId: string,
  ordinal: number,
  claim: string,
  anchor: EvidenceAnchor,
  association?: {
    readonly citationId: string;
    readonly claimSpan: string;
  }
): KnowledgeEvidenceCitation {
  if (claim.trim() === "") throw new Error("Citation claim is required");
  if (association && (!/^cite_[0-9a-f]{20}$/.test(association.citationId) || association.claimSpan.trim() === "")) {
    throw new Error("Citation public claim association is invalid");
  }
  return {
    id: stableId("kc", { revisionId, ordinal, claim, association, anchor }),
    revisionId,
    ordinal,
    claim: claim.trim(),
    ...(association
      ? {
          citationId: association.citationId,
          claimSpan: association.claimSpan.trim()
        }
      : {}),
    anchor
  };
}
