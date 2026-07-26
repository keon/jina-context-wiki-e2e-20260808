import type { EvidenceAnchor, EvidenceRecord } from "../domain/evidence.js";
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

function claimSupportsParagraph(claim: string, paragraph: string): boolean {
  const normalizedClaim = claim.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedParagraph = paragraph.toLowerCase().replace(/\s+/g, " ").trim();
  return normalizedClaim.length >= 12 && normalizedParagraph.includes(normalizedClaim);
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
  }): Promise<ValidatedKnowledge> {
    const checkpoint = await this.evidenceStore.getCheckpoint(input.checkpointId);
    if (checkpoint === undefined) throw new KnowledgeValidationError(["Unknown evidence checkpoint"]);
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
      const resolved: { claim: string; anchor: EvidenceAnchor; record: EvidenceRecord }[] = [];
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
          resolved.push({
            claim: citation.claim,
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
      for (const paragraph of materialParagraphs(document.bodyMarkdown)) {
        if (!resolved.some((citation) => claimSupportsParagraph(citation.claim, paragraph))) {
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
        title: document.title,
        bodyMarkdown: document.bodyMarkdown,
        summary: document.summary,
        structuredSummary: document.structuredSummary,
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
