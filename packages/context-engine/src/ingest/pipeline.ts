import type {
  EvidenceCheckpoint,
  EvidenceRecord,
  EvidenceSnapshot,
  GitSnapshotMetadata,
  RefManifestEntry,
  StructuralFact
} from "../domain/evidence.js";
import { createEvidenceRecord } from "../domain/evidence.js";
import {
  fingerprint,
  isFullCommitSha,
  normalizeIsoTime,
  normalizeRepository,
  stableId
} from "../domain/fingerprint.js";
import type { EvidenceStore } from "../ports/evidence-store.js";
import type { ContextWriteFence } from "../workflow/coordinator.js";
import { DeterministicSourceParser, type SourceParser } from "./parser.js";
import { normalizeProviderObservation, type ProviderObservationInput } from "./provider-normalizers.js";

export interface IngestFile {
  path: string;
  blobSha: string;
  body: string;
  language?: string;
  executable?: boolean;
  aclFingerprint?: string;
  contentOmitted?: boolean;
}

export interface IngestEvidenceInput {
  tenantId: string;
  repository: string;
  ref: string;
  refSequence: number;
  commitSha: string;
  files: IngestFile[];
  observations?: ProviderObservationInput[];
  aclFingerprint: string;
  observationFrontier: string;
  createdAt: string;
  sourceComplete: boolean;
  git?: GitSnapshotMetadata;
}

export const CONTEXT_ENGINE_PARSER_VERSION = "deterministic-source-v1";

export class IngestEvidenceService {
  readonly #parser: SourceParser;

  constructor(
    private readonly store: EvidenceStore,
    parser: SourceParser = new DeterministicSourceParser(CONTEXT_ENGINE_PARSER_VERSION)
  ) {
    this.#parser = parser;
  }

  async ingest(input: IngestEvidenceInput, fence?: ContextWriteFence): Promise<EvidenceCheckpoint> {
    if (!isFullCommitSha(input.commitSha)) throw new Error("commitSha must be a full Git SHA");
    if (input.ref.trim() === "") throw new Error("ref is required");
    if (!Number.isSafeInteger(input.refSequence) || input.refSequence <= 0) {
      throw new Error("refSequence must be a positive safe integer");
    }
    if (input.aclFingerprint.trim() === "") throw new Error("aclFingerprint is required");
    const repository = normalizeRepository(input.repository);
    const createdAt = normalizeIsoTime(input.createdAt);
    if (input.git !== undefined) validateGitSnapshot(input.git);
    const files = [...input.files].sort((left, right) => left.path.localeCompare(right.path));
    if (new Set(files.map((file) => file.path)).size !== files.length) {
      throw new Error("A source snapshot cannot contain duplicate paths");
    }
    const records: EvidenceRecord[] = [];
    const manifest: RefManifestEntry[] = [];
    const structuralFacts: StructuralFact[] = [];
    for (const file of files) {
      if (file.path.trim() === "" || file.path.startsWith("/") || file.path.includes("\u0000")) {
        throw new Error(`Invalid repository path: ${file.path}`);
      }
      if (!isFullCommitSha(file.blobSha)) throw new Error(`blobSha must be a full Git SHA for ${file.path}`);
      const contentDigest = fingerprint(file.body);
      const anchor = {
        tenantId: input.tenantId,
        repository,
        sourceType: "blob" as const,
        sourceId: file.blobSha,
        contentDigest,
        commitSha: input.commitSha,
        pathOrUrl: file.path
      };
      records.push(
        createEvidenceRecord({
          anchor,
          ref: input.ref,
          title: file.path,
          body: file.body,
          metadata: {
            language: file.language ?? null,
            blobSha: file.blobSha,
            contentOmitted: file.contentOmitted ?? false
          },
          authorityClass: "source_code",
          aclFingerprint: file.aclFingerprint ?? input.aclFingerprint,
          createdAt
        })
      );
      manifest.push({
        tenantId: input.tenantId,
        repository,
        ref: input.ref,
        commitSha: input.commitSha,
        path: file.path,
        blobSha: file.blobSha,
        contentDigest,
        ...(file.language === undefined ? {} : { language: file.language }),
        executable: file.executable ?? false
      });
      if (!file.contentOmitted && this.#parser.supports(file.path, file.language)) {
        structuralFacts.push(
          ...this.#parser.analyze({
            tenantId: input.tenantId,
            repository,
            ref: input.ref,
            commitSha: input.commitSha,
            path: file.path,
            blobSha: file.blobSha,
            contentDigest,
            body: file.body,
            ...(file.language === undefined ? {} : { language: file.language })
          }).facts
        );
      }
    }
    for (const observationInput of input.observations ?? []) {
      const observation = normalizeProviderObservation(observationInput);
      records.push(
        createEvidenceRecord({
          anchor: {
            tenantId: input.tenantId,
            repository,
            sourceType: observation.sourceType,
            sourceId: observation.sourceId,
            contentDigest: observation.contentDigest,
            commitSha: input.commitSha,
            ...(observation.pathOrUrl === undefined ? {} : { pathOrUrl: observation.pathOrUrl }),
            observedAt: observation.observedAt
          },
          ref: input.ref,
          title: observation.title,
          body: observation.body,
          metadata: observation.metadata,
          authorityClass: observation.authorityClass,
          aclFingerprint: input.aclFingerprint,
          createdAt
        })
      );
    }
    const evidenceFingerprint = fingerprint(
      records.map((record) => ({ anchor: record.anchor, aclFingerprint: record.aclFingerprint }))
    );
    const manifestFingerprint = fingerprint(manifest);
    const checkpoint: EvidenceCheckpoint = {
      id: stableId("ec", {
        tenantId: input.tenantId,
        repository,
        ref: input.ref,
        refSequence: input.refSequence,
        commitSha: input.commitSha,
        parserVersion: this.#parser.version,
        sourceCompleteness: input.sourceComplete ? "complete" : "partial",
        observationFrontier: input.observationFrontier,
        evidenceFingerprint,
        manifestFingerprint,
        aclFingerprint: input.aclFingerprint
      }),
      tenantId: input.tenantId,
      repository,
      ref: input.ref,
      refSequence: input.refSequence,
      commitSha: input.commitSha,
      parserVersion: this.#parser.version,
      sourceCompleteness: input.sourceComplete ? "complete" : "partial",
      observationFrontier: input.observationFrontier,
      evidenceFingerprint,
      manifestFingerprint,
      aclFingerprint: input.aclFingerprint,
      createdAt
    };
    const snapshot: EvidenceSnapshot = {
      checkpoint,
      records,
      manifest,
      structuralFacts,
      ...(input.git === undefined
        ? {}
        : {
            git: {
              commit: {
                ...input.git.commit,
                parentShas: [...input.git.commit.parentShas],
                ...(input.git.commit.authoredAt ? { authoredAt: normalizeIsoTime(input.git.commit.authoredAt) } : {}),
                ...(input.git.commit.committedAt ? { committedAt: normalizeIsoTime(input.git.commit.committedAt) } : {})
              },
              changes: input.git.changes.map((change) => ({ ...change })),
              ...(input.git.history === undefined
                ? {}
                : {
                    history: input.git.history.map((commit) => ({
                      ...commit,
                      parentShas: [...commit.parentShas],
                      ...(commit.authoredAt ? { authoredAt: normalizeIsoTime(commit.authoredAt) } : {}),
                      ...(commit.committedAt ? { committedAt: normalizeIsoTime(commit.committedAt) } : {})
                    }))
                  })
            }
          })
    };
    return this.store.commitSnapshot(snapshot, fence);
  }
}

function validateGitSnapshot(git: GitSnapshotMetadata): void {
  if (!isFullCommitSha(git.commit.treeSha)) throw new Error("git.commit.treeSha must be a full Git SHA");
  if (git.commit.parentShas.some((sha) => !isFullCommitSha(sha))) {
    throw new Error("git.commit.parentShas must contain full Git SHAs");
  }
  for (const commit of git.history ?? []) {
    if (!isFullCommitSha(commit.sha) || !isFullCommitSha(commit.treeSha)) {
      throw new Error("git.history commit and tree SHAs must be full Git SHAs");
    }
    if (commit.parentShas.some((sha) => !isFullCommitSha(sha))) {
      throw new Error("git.history parentShas must contain full Git SHAs");
    }
  }
  for (const change of git.changes) {
    if (!change.path || change.path.startsWith("/") || change.path.includes("\u0000")) {
      throw new Error("git change path is invalid");
    }
    if (change.oldBlobSha !== undefined && !isFullCommitSha(change.oldBlobSha)) {
      throw new Error("git change oldBlobSha must be a full Git SHA");
    }
    if (change.newBlobSha !== undefined && !isFullCommitSha(change.newBlobSha)) {
      throw new Error("git change newBlobSha must be a full Git SHA");
    }
    if (change.kind === "add" && change.newBlobSha === undefined) throw new Error("git add requires newBlobSha");
    if (change.kind === "delete" && change.oldBlobSha === undefined) throw new Error("git delete requires oldBlobSha");
    if (
      ["modify", "rename", "copy"].includes(change.kind) &&
      (change.oldBlobSha === undefined || change.newBlobSha === undefined)
    ) {
      throw new Error(`git ${change.kind} requires oldBlobSha and newBlobSha`);
    }
  }
}
