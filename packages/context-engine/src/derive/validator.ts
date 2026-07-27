import { evidenceExcerpt, type EvidenceAnchor, type EvidenceRecord } from "../domain/evidence.js";
import { fingerprint, isFullCommitSha } from "../domain/fingerprint.js";
import {
  createKnowledgeCitation,
  createKnowledgeRevision,
  validateLogicalId,
  type CitedKnowledgeStatement,
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

function materialBodyBlocks(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((value) => value.trim())
    .filter((value) => value !== "" && !value.split(/\r?\n/).every((line) => /^#{1,6}\s+\S/.test(line.trim())));
}

function bodyCitationOrdinals(block: string): number[] | undefined {
  const match = /\[cite:([1-9][0-9]*(?:\s*,\s*[1-9][0-9]*)*)\]\s*$/.exec(block);
  if (!match) return undefined;
  return [...new Set(match[1]!.split(",").map((value) => Number(value.trim())))];
}

function evidenceSupportsClaim(claim: string, excerpt: string): boolean {
  const normalizedClaim = claim.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedExcerpt = excerpt.toLowerCase().replace(/\s+/g, " ").trim();
  return normalizedClaim.length >= 8 && normalizedExcerpt.includes(normalizedClaim);
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

function structuredStatements(document: KnowledgeGenerationOutput["documents"][number]): CitedKnowledgeStatement[] {
  const diagnostics = document.structuredSummary.diagnostics;
  return [
    ...document.structuredSummary.facts,
    ...document.structuredSummary.questionsAnswered,
    ...diagnostics.symptoms,
    ...diagnostics.causes,
    ...diagnostics.checks,
    ...diagnostics.fixes
  ];
}

function citationOrdinalError(
  ordinals: readonly number[],
  citationCount: number,
  path: string,
  required: boolean
): string | undefined {
  if (required && ordinals.length === 0) return `${path} must contain at least one citation ordinal`;
  const invalid = ordinals.find((ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > citationCount);
  return invalid === undefined ? undefined : `${path} references missing citation ${invalid}`;
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
    const logicalIds = input.output.documents.map((document) => document.logicalId);
    if (new Set(logicalIds).size !== logicalIds.length) {
      throw new KnowledgeValidationError(["output contains duplicate logical IDs"]);
    }
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
      const summaryOrdinalError = citationOrdinalError(
        document.summaryCitationOrdinals,
        resolved.length,
        `documents[${documentIndex}].summaryCitationOrdinals`,
        true
      );
      if (summaryOrdinalError) diagnostics.push(summaryOrdinalError);
      for (const [statementIndex, statement] of structuredStatements(document).entries()) {
        const statementPath = `documents[${documentIndex}].structuredSummary.statements[${statementIndex}]`;
        const ordinalError = citationOrdinalError(statement.citationOrdinals, resolved.length, statementPath, true);
        if (ordinalError) diagnostics.push(ordinalError);
        if (statement.confidence < 0 || statement.confidence > 1) {
          diagnostics.push(`${statementPath}.confidence must be between 0 and 1`);
        }
      }
      const claimSubject = document.structuredSummary.claimSubject;
      const claimValue = document.structuredSummary.claimValue;
      if ((claimSubject === undefined) !== (claimValue === undefined)) {
        diagnostics.push(`documents[${documentIndex}].structuredSummary claimSubject and claimValue must be paired`);
      }
      const claimOrdinalError = citationOrdinalError(
        document.structuredSummary.claimCitationOrdinals,
        resolved.length,
        `documents[${documentIndex}].structuredSummary.claimCitationOrdinals`,
        claimSubject !== undefined
      );
      if (claimOrdinalError) diagnostics.push(claimOrdinalError);
      if (claimSubject === undefined && document.structuredSummary.claimCitationOrdinals.length > 0) {
        diagnostics.push(
          `documents[${documentIndex}].structuredSummary.claimCitationOrdinals requires claimSubject and claimValue`
        );
      }
      for (const block of materialBodyBlocks(document.bodyMarkdown)) {
        const ordinals = bodyCitationOrdinals(block);
        if (!ordinals) {
          diagnostics.push(
            `documents[${documentIndex}] contains a body paragraph without a trailing citation marker: ${block.slice(0, 80)}`
          );
          continue;
        }
        const ordinalError = citationOrdinalError(
          ordinals,
          resolved.length,
          `documents[${documentIndex}].bodyMarkdown`,
          true
        );
        if (ordinalError) diagnostics.push(ordinalError);
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
        structuredSummary: { ...document.structuredSummary },
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
