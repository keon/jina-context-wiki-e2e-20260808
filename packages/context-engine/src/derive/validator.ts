import { evidenceExcerpt, type EvidenceAnchor, type EvidenceRecord } from "../domain/evidence.js";
import { fingerprint, isFullCommitSha } from "../domain/fingerprint.js";
import {
  createKnowledgeCitation,
  createKnowledgeRevision,
  validateLogicalId,
  type KnowledgeDocumentRevision,
  type KnowledgeEvidenceCitation,
  type KnowledgeGenerationOutput
} from "../domain/knowledge.js";
import type { EvidenceStore } from "../ports/evidence-store.js";

export interface ValidatedKnowledge {
  revisions: KnowledgeDocumentRevision[];
  citations: KnowledgeEvidenceCitation[];
}

export class KnowledgeValidationError extends Error {
  constructor(readonly diagnostics: string[]) {
    super(`Knowledge validation failed: ${diagnostics.join("; ")}`);
  }
}

function materialParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((value) => value.replace(/^#+\s*/gm, "").trim())
    .filter((value) => value !== "" && !/^[-*]\s*$/.test(value));
}

function claimsCoverParagraph(claims: readonly string[], paragraph: string): boolean {
  let remaining = paragraph.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedClaims = claims
    .map((claim) => claim.toLowerCase().replace(/\s+/g, " ").trim())
    .filter((claim) => claim.length >= 12)
    .sort((left, right) => right.length - left.length);
  for (const claim of normalizedClaims) {
    remaining = remaining.split(claim).join(" ");
  }
  return remaining.replace(/[\s`*_~#[\](){}<>:;,.!?'"|/+\\=-]/g, "") === "";
}

function evidenceSupportsClaim(claim: string, excerpt: string): boolean {
  const normalizedClaim = claim.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedExcerpt = excerpt.toLowerCase().replace(/\s+/g, " ").trim();
  return normalizedClaim.length >= 8 && normalizedExcerpt.includes(normalizedClaim);
}

function textSupportedByClaims(value: string, claims: readonly string[]): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    normalized.length >= 3 && claims.some((claim) => claim.toLowerCase().replace(/\s+/g, " ").includes(normalized))
  );
}

function textSupportedByResolvedEvidence(
  value: string,
  resolved: readonly { claim: string; excerpt: string; record: EvidenceRecord }[]
): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length < 2) return false;
  return resolved.some(({ claim, excerpt, record }) =>
    [claim, excerpt, record.anchor.pathOrUrl ?? "", record.anchor.sourceId]
      .map((candidate) => candidate.toLowerCase().replace(/\s+/g, " "))
      .some((candidate) => candidate.includes(normalized))
  );
}

function structuredSummaryStrings(summary: Record<string, unknown>): string[] {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(summary);
  return values;
}

function logicalIdGroundingError(
  document: KnowledgeGenerationOutput["documents"][number],
  repository: string,
  commitSha: string,
  resolved: readonly { claim: string; excerpt: string; record: EvidenceRecord }[]
): string | undefined {
  const logicalId = document.logicalId.toLowerCase();
  const normalizedRepository = repository.toLowerCase();
  if (document.kind === "architecture") {
    return logicalId === `repository:${normalizedRepository}:architecture`
      ? undefined
      : "repository identity does not match the checkpoint";
  }
  if (document.kind === "change_summary") {
    return logicalId === `change:${normalizedRepository}:${commitSha.toLowerCase()}`
      ? undefined
      : "commit identity does not match the checkpoint";
  }
  if (document.kind === "issue_explanation") {
    const issue = /^issue:[a-z0-9_.-]+:([a-z0-9_.-]+\/[a-z0-9_.-]+)#([1-9][0-9]*)$/.exec(logicalId);
    if (!issue || issue[1] !== normalizedRepository) return "repository identity does not match the checkpoint";
    const issueNumber = issue[2]!;
    const issueNumberPattern = new RegExp(`(^|[^0-9])${issueNumber}([^0-9]|$)`);
    const supported = resolved.some(
      ({ claim, excerpt, record }) =>
        record.anchor.sourceType === "issue" &&
        [claim, excerpt, record.anchor.sourceId, record.anchor.pathOrUrl ?? "", JSON.stringify(record.metadata)]
          .map((candidate) => candidate.toLowerCase())
          .some((candidate) => issueNumberPattern.test(candidate))
    );
    return supported ? undefined : "issue identity is not supported by resolved issue evidence";
  }
  const prefix = document.kind === "incident" ? "incident:" : `${document.kind}:${normalizedRepository}:`;
  if (!logicalId.startsWith(prefix)) return "repository identity does not match the checkpoint";
  const suffix = logicalId.slice(prefix.length);
  const segments = suffix.split(/[/:#@._-]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => !textSupportedByResolvedEvidence(segment, resolved))) {
    return "identity suffix is not fully supported by resolved evidence";
  }
  return undefined;
}

export class KnowledgeOutputValidator {
  constructor(private readonly evidenceStore: EvidenceStore) {}

  async validate(input: {
    output: KnowledgeGenerationOutput;
    checkpointId: string;
    generatorName: string;
    generatorVersion: string;
    model: string;
    promptVersion: string;
    createdAt: string;
    repairPresentationFields?: boolean;
  }): Promise<ValidatedKnowledge> {
    const checkpoint = await this.evidenceStore.getCheckpoint(input.checkpointId);
    if (checkpoint === undefined) throw new KnowledgeValidationError(["Unknown evidence checkpoint"]);
    const manifestPaths = new Set(
      (await this.evidenceStore.listManifest(input.checkpointId)).map((entry) => entry.path)
    );
    const diagnostics: string[] = [];
    const revisions: KnowledgeDocumentRevision[] = [];
    const citations: KnowledgeEvidenceCitation[] = [];
    for (const [documentIndex, document] of input.output.documents.entries()) {
      try {
        validateLogicalId(document.kind, document.logicalId, checkpoint.repository);
      } catch (error) {
        diagnostics.push(`documents[${documentIndex}]: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (document.confidence < 0 || document.confidence > 1) {
        diagnostics.push(`documents[${documentIndex}].confidence must be between 0 and 1`);
        continue;
      }
      for (const path of document.scope.paths) {
        if (path.startsWith("/") || path.includes(".."))
          diagnostics.push(`documents[${documentIndex}] has invalid scope path`);
      }
      const resolved: { claim: string; excerpt: string; anchor: EvidenceAnchor; record: EvidenceRecord }[] = [];
      for (const [citationIndex, citation] of document.citations.entries()) {
        const record = await this.evidenceStore.resolveAnchor(input.checkpointId, {
          tenantId: checkpoint.tenantId,
          repository: checkpoint.repository,
          sourceType: citation.sourceType,
          sourceId: citation.sourceId,
          commitSha: checkpoint.commitSha,
          ...(citation.pathOrUrl === undefined ? {} : { pathOrUrl: citation.pathOrUrl }),
          ...(citation.startLine === undefined ? {} : { startLine: citation.startLine }),
          ...(citation.endLine === undefined ? {} : { endLine: citation.endLine }),
          ...(citation.jsonPointer === undefined ? {} : { jsonPointer: citation.jsonPointer })
        });
        if (record === undefined) {
          diagnostics.push(`documents[${documentIndex}].citations[${citationIndex}] does not resolve`);
        } else {
          const excerpt = evidenceExcerpt(record, citation);
          if (excerpt === undefined) {
            diagnostics.push(`documents[${documentIndex}].citations[${citationIndex}] has an invalid selector`);
            continue;
          }
          if (!evidenceSupportsClaim(citation.claim, excerpt)) {
            diagnostics.push(
              `documents[${documentIndex}].citations[${citationIndex}] claim is not present in the cited evidence`
            );
            continue;
          }
          resolved.push({
            claim: citation.claim,
            excerpt,
            record,
            anchor: {
              ...record.anchor,
              ...(citation.pathOrUrl === undefined && record.anchor.pathOrUrl === undefined
                ? {}
                : { pathOrUrl: citation.pathOrUrl ?? record.anchor.pathOrUrl! }),
              ...(citation.startLine === undefined ? {} : { startLine: citation.startLine }),
              ...(citation.endLine === undefined ? {} : { endLine: citation.endLine }),
              ...(citation.jsonPointer === undefined ? {} : { jsonPointer: citation.jsonPointer })
            }
          });
        }
      }
      if (resolved.length !== document.citations.length) continue;
      const claims = resolved.map((citation) => citation.claim);
      // A bounded repair may discard unsupported prose, but it must never
      // invent replacement knowledge. Canonicalizing the presentation from
      // already-resolved verbatim claims keeps the raw model output auditable
      // while ensuring every published word remains source-grounded.
      const repairedClaims = input.repairPresentationFields ? [...new Set(claims)] : undefined;
      const title = repairedClaims?.[0] ?? document.title;
      const summary = repairedClaims?.[0] ?? document.summary;
      const bodyMarkdown = repairedClaims?.join("\n\n") ?? document.bodyMarkdown;
      const structuredSummary = repairedClaims ? { facts: repairedClaims } : document.structuredSummary;
      if (!textSupportedByClaims(title, claims)) {
        diagnostics.push(`documents[${documentIndex}].title is not supported by a citation claim`);
      }
      if (!textSupportedByClaims(summary, claims)) {
        diagnostics.push(`documents[${documentIndex}].summary is not supported by a citation claim`);
      }
      for (const value of structuredSummaryStrings(structuredSummary)) {
        if (!textSupportedByClaims(value, claims)) {
          diagnostics.push(`documents[${documentIndex}].structuredSummary contains unsupported text`);
          break;
        }
      }
      for (const path of document.scope.paths) {
        if (!manifestPaths.has(path)) {
          diagnostics.push(`documents[${documentIndex}].scope.paths contains a path outside the checkpoint`);
        } else if (!textSupportedByResolvedEvidence(path, resolved)) {
          diagnostics.push(`documents[${documentIndex}].scope.paths contains a path not supported by cited evidence`);
        }
      }
      for (const value of [...document.scope.symbols, ...document.scope.pullRequests, ...document.scope.issues]) {
        if (!textSupportedByResolvedEvidence(value, resolved)) {
          diagnostics.push(`documents[${documentIndex}].scope contains unsupported text`);
          break;
        }
      }
      const logicalIdError = logicalIdGroundingError(document, checkpoint.repository, checkpoint.commitSha, resolved);
      if (logicalIdError) {
        diagnostics.push(`documents[${documentIndex}].logicalId ${logicalIdError}`);
      }
      for (const paragraph of materialParagraphs(bodyMarkdown)) {
        if (!claimsCoverParagraph(claims, paragraph)) {
          diagnostics.push(`documents[${documentIndex}] contains an unsupported paragraph: ${paragraph.slice(0, 80)}`);
        }
      }
      if (diagnostics.some((value) => value.startsWith(`documents[${documentIndex}]`))) continue;
      if (!isFullCommitSha(checkpoint.commitSha)) {
        diagnostics.push(`documents[${documentIndex}] checkpoint commit is invalid`);
        continue;
      }
      const evidenceFingerprint = fingerprint(resolved.map(({ claim, anchor }) => ({ claim, anchor })));
      const revision = createKnowledgeRevision({
        logicalId: document.logicalId,
        tenantId: checkpoint.tenantId,
        repository: checkpoint.repository,
        kind: document.kind,
        title,
        bodyMarkdown,
        summary,
        structuredSummary,
        scope: {
          ref: checkpoint.ref,
          commitSha: checkpoint.commitSha,
          paths: [...new Set(document.scope.paths)].sort(),
          symbols: [...new Set(document.scope.symbols)].sort(),
          pullRequests: [...new Set(document.scope.pullRequests)].sort(),
          issues: [...new Set(document.scope.issues)].sort()
        },
        evidenceFingerprint,
        generatorName: input.generatorName,
        generatorVersion: input.generatorVersion,
        model: input.model,
        promptVersion: input.promptVersion,
        confidence: document.confidence,
        createdAt: input.createdAt
      });
      revisions.push(revision);
      citations.push(
        ...resolved.map((citation, ordinal) =>
          createKnowledgeCitation(revision.id, ordinal, citation.claim, citation.anchor)
        )
      );
    }
    if (diagnostics.length > 0) throw new KnowledgeValidationError(diagnostics);
    return { revisions, citations };
  }
}
