import { createHash } from "node:crypto";
import type { EvidenceSnapshot } from "../domain/evidence.js";
import { validateEvidenceAnchor } from "../domain/evidence.js";
import {
  canonicalJson,
  fingerprint,
  isFullCommitSha,
  normalizeIsoTime,
  normalizeRepository,
  stableId
} from "../domain/fingerprint.js";
import type { DerivationRun, KnowledgeDocumentRevision, KnowledgeEvidenceCitation } from "../domain/knowledge.js";
import { isContextArtifactKeyInRepositoryScope, type ContextArtifactRef } from "../ports/artifact-store.js";

/**
 * Exact public bytes covered by challenge, evaluation, certification, release,
 * and PageIndex. Keeping this canonicalization in the domain prevents a worker
 * and the authoritative publisher from silently certifying different bytes.
 */
export interface ContextPublicPage {
  readonly documentPath: string;
  readonly title: string;
  readonly bodyMarkdown: string;
}

export function canonicalContextPublicPages<T extends ContextPublicPage>(pages: readonly T[]): T[] {
  return [...pages].sort((left, right) => left.documentPath.localeCompare(right.documentPath));
}

export function contextPublicSnapshot(pages: readonly ContextPublicPage[]): string {
  return canonicalContextPublicPages(pages)
    .map((page) => `<!-- context-page:${page.documentPath} -->\n${page.bodyMarkdown.trim()}\n`)
    .join("");
}

export function contextPublicSnapshotDigest(pages: readonly ContextPublicPage[]): string {
  return createHash("sha256").update(contextPublicSnapshot(pages)).digest("hex");
}

export interface CertifiedContextReleasePage extends ContextPublicPage {
  readonly bodySha256: string;
  readonly revisionId: string;
  readonly citations: readonly KnowledgeEvidenceCitation[];
}

export interface CertifiedContextReleaseArtifactV1 {
  readonly version: 1;
  readonly release: {
    readonly releaseId: string;
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
    readonly refSequence: number;
    readonly commitSha: string;
    readonly checkpointId: string;
    readonly buildId: string;
    readonly publishedAt: string;
  };
  readonly certificationArtifact: ContextArtifactRef;
  readonly publicationPlanArtifact: ContextArtifactRef;
  readonly publicSnapshotDigest: string;
  readonly publicationInputDigest: string;
  readonly pages: readonly CertifiedContextReleasePage[];
}

export interface BoardPublicationLeaseFence {
  readonly taskId: string;
  readonly messageId: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly writeFenceToken: string;
  /** The database must compare this lease identity to its live board row. */
  readonly leaseExpiresAt: string;
}

export interface BoardContextPublicationScope {
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly commitSha: string;
  readonly buildId: string;
}

/**
 * Fully validated material for one authoritative publication transaction.
 *
 * Implementations MUST, in one database transaction:
 *  1. lock and revalidate `lease`;
 *  2. lock the tenant/repository/ref publication frontier;
 *  3. enforce idempotencyKey -> publicationInputDigest immutability;
 *  4. reject a frontier newer than scope.refSequence;
 *  5. persist evidence, revisions, citations, and the complete projection;
 *  6. persist releaseArtifact and a complete prepared projection without
 *     making either one query-visible.
 *
 * Splitting these operations across ContextEngineStore methods does not satisfy
 * this contract. In particular, the existing commitKnowledge + index sequence
 * is deliberately not adapted here because doing so would fake atomicity.
 *
 * A successful call creates an immutable prepared release. Prepared releases
 * are intentionally unavailable to list/read/search/diff, including explicit
 * release-ID access. The independently resumable PageIndex attachment
 * transaction is the only operation allowed to mark the projection published
 * and advance the ref's public current pointer.
 */
export interface BoardContextPublicationCommit {
  readonly scope: BoardContextPublicationScope;
  readonly lease: BoardPublicationLeaseFence;
  readonly idempotencyKey: string;
  readonly publicationInputDigest: string;
  readonly publicSnapshotDigest: string;
  readonly releaseId: string;
  readonly releaseArtifact: ContextArtifactRef;
  readonly certificationArtifact: ContextArtifactRef;
  readonly publicationPlanArtifact: ContextArtifactRef;
  readonly snapshot: EvidenceSnapshot;
  readonly run: DerivationRun;
  readonly revisions: readonly KnowledgeDocumentRevision[];
  readonly citations: readonly KnowledgeEvidenceCitation[];
  readonly pages: readonly CertifiedContextReleasePage[];
  readonly priorRelease?: ContextPriorReleaseSeed;
  readonly publishedAt: string;
}

export interface BoardContextPublicationRecord {
  readonly releaseId: string;
  readonly publicationInputDigest: string;
  readonly publicSnapshotDigest: string;
  readonly releaseArtifact: ContextArtifactRef;
  readonly refSequence: number;
  readonly commitSha: string;
  readonly publishedAt: string;
}

/**
 * Immutable current-release identity captured when a newer build is admitted.
 * The redundant repository scope is intentional: Board metadata and workers
 * can reject a cross-tenant/ref artifact before reading its bytes.
 */
export interface ContextPriorReleaseSeed {
  readonly version: 1;
  readonly tenantId: string;
  readonly repository: string;
  readonly ref: string;
  readonly refSequence: number;
  readonly commitSha: string;
  readonly releaseId: string;
  readonly publicSnapshotDigest: string;
  readonly releaseArtifact: ContextArtifactRef;
}

export interface BoardContextReleaseSeedPort {
  findCurrentReleaseSeed(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly ref: string;
  }): Promise<ContextPriorReleaseSeed | undefined>;
}

export interface BoardContextPublicationTransactionPort {
  publishAtomically(input: BoardContextPublicationCommit): Promise<BoardContextPublicationRecord>;
}

export type BoardContextPublicationErrorCode =
  | "invalid_publication"
  | "certification_mismatch"
  | "idempotency_conflict"
  | "stale_ref_sequence"
  | "stale_publication_lease"
  | "publication_race";

export class BoardContextPublicationError extends Error {
  constructor(
    readonly code: BoardContextPublicationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BoardContextPublicationError";
  }
}

export function boardContextPublicationInputDigest(input: {
  readonly scope: BoardContextPublicationScope;
  readonly certificationArtifact: ContextArtifactRef;
  readonly publicationPlanArtifact: ContextArtifactRef;
  readonly checkpointId: string;
  readonly publicSnapshotDigest: string;
  readonly pages: readonly {
    readonly documentPath: string;
    readonly bodySha256: string;
    readonly revisionId: string;
    readonly citationIds: readonly string[];
  }[];
}): string {
  return fingerprint({
    version: 1,
    scope: input.scope,
    certificationArtifact: artifactIdentity(input.certificationArtifact),
    publicationPlanArtifact: artifactIdentity(input.publicationPlanArtifact),
    checkpointId: input.checkpointId,
    publicSnapshotDigest: input.publicSnapshotDigest,
    pages: [...input.pages]
      .sort((left, right) => left.documentPath.localeCompare(right.documentPath))
      .map((page) => ({
        ...page,
        citationIds: [...page.citationIds].sort()
      }))
  });
}

export function boardContextReleaseId(publicationInputDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(publicationInputDigest)) {
    throw new BoardContextPublicationError("invalid_publication", "publication input digest must be SHA-256");
  }
  return stableId("cr", { version: 1, publicationInputDigest });
}

export function serializeCertifiedContextReleaseArtifact(artifact: CertifiedContextReleaseArtifactV1): string {
  return `${canonicalJson(artifact)}\n`;
}

/** Strict runtime boundary for PageIndex and any release-artifact consumer. */
export function parseCertifiedContextReleaseArtifact(value: unknown): CertifiedContextReleaseArtifactV1 {
  const input = objectValue(value, "context release artifact");
  if (input.version !== 1) throw invalidRelease("context release artifact version must be 1");
  const rawRelease = objectValue(input.release, "context release identity");
  const release = {
    releaseId: stringValue(rawRelease.releaseId, "releaseId", 240),
    tenantId: stringValue(rawRelease.tenantId, "tenantId", 240),
    repository: normalizeRepository(stringValue(rawRelease.repository, "repository", 512)),
    ref: stringValue(rawRelease.ref, "ref", 512),
    refSequence: integerValue(rawRelease.refSequence, "refSequence", 1),
    commitSha: stringValue(rawRelease.commitSha, "commitSha", 40).toLowerCase(),
    checkpointId: stringValue(rawRelease.checkpointId, "checkpointId", 240),
    buildId: stringValue(rawRelease.buildId, "buildId", 240),
    publishedAt: normalizeIsoTime(stringValue(rawRelease.publishedAt, "publishedAt", 64))
  };
  if (!isFullCommitSha(release.commitSha)) throw invalidRelease("context release commitSha must be a full Git SHA");
  const certificationArtifact = artifactRefValue(input.certificationArtifact, "certificationArtifact");
  const publicationPlanArtifact = artifactRefValue(input.publicationPlanArtifact, "publicationPlanArtifact");
  const publicSnapshotDigest = digestValue(input.publicSnapshotDigest, "publicSnapshotDigest");
  const publicationInputDigest = digestValue(input.publicationInputDigest, "publicationInputDigest");
  if (!Array.isArray(input.pages) || input.pages.length === 0 || input.pages.length > 96) {
    throw invalidRelease("context release pages must contain between 1 and 96 items");
  }
  const pages = input.pages.map((candidate, pageIndex): CertifiedContextReleasePage => {
    const page = objectValue(candidate, `pages[${pageIndex}]`);
    const documentPath = publicPagePath(page.documentPath, `pages[${pageIndex}].documentPath`);
    const revisionId = stringValue(page.revisionId, `pages[${pageIndex}].revisionId`, 240);
    const bodyMarkdown = stringValue(page.bodyMarkdown, `pages[${pageIndex}].bodyMarkdown`, 2 * 1024 * 1024);
    const bodySha256 = digestValue(page.bodySha256, `pages[${pageIndex}].bodySha256`);
    if (createHash("sha256").update(bodyMarkdown).digest("hex") !== bodySha256) {
      throw invalidRelease(`context release page body digest mismatch for ${documentPath}`);
    }
    if (!Array.isArray(page.citations)) {
      throw invalidRelease(`context release citations are invalid for ${documentPath}`);
    }
    const citations = page.citations.map((candidateCitation, citationIndex): KnowledgeEvidenceCitation => {
      const citation = objectValue(candidateCitation, `pages[${pageIndex}].citations[${citationIndex}]`);
      const anchor = validateEvidenceAnchor(
        objectValue(
          citation.anchor,
          `pages[${pageIndex}].citations[${citationIndex}].anchor`
        ) as unknown as KnowledgeEvidenceCitation["anchor"]
      );
      if (
        anchor.tenantId !== release.tenantId ||
        anchor.repository !== release.repository ||
        (anchor.commitSha !== undefined && anchor.commitSha !== release.commitSha) ||
        (anchor.sourceType === "blob" && anchor.commitSha === undefined)
      ) {
        throw invalidRelease(`context release citation scope mismatch for ${documentPath}`);
      }
      const citationId =
        citation.citationId === undefined
          ? undefined
          : stringValue(citation.citationId, `pages[${pageIndex}].citations[${citationIndex}].citationId`, 64);
      const claimSpan =
        citation.claimSpan === undefined
          ? undefined
          : stringValue(citation.claimSpan, `pages[${pageIndex}].citations[${citationIndex}].claimSpan`, 8_192);
      if (
        (citationId === undefined) !== (claimSpan === undefined) ||
        (citationId && !/^cite_[0-9a-f]{20}$/.test(citationId))
      ) {
        throw invalidRelease(`context release public citation association is invalid for ${documentPath}`);
      }
      const parsedCitation: KnowledgeEvidenceCitation = {
        id: stringValue(citation.id, `pages[${pageIndex}].citations[${citationIndex}].id`, 240),
        revisionId: stringValue(citation.revisionId, `pages[${pageIndex}].citations[${citationIndex}].revisionId`, 240),
        ordinal: integerValue(citation.ordinal, `pages[${pageIndex}].citations[${citationIndex}].ordinal`, 0),
        claim: stringValue(citation.claim, `pages[${pageIndex}].citations[${citationIndex}].claim`, 8_192),
        ...(citationId ? { citationId, claimSpan: claimSpan! } : {}),
        anchor
      };
      if (parsedCitation.revisionId !== revisionId || parsedCitation.ordinal !== citationIndex) {
        throw invalidRelease(`context release citation ordering or revision binding is invalid for ${documentPath}`);
      }
      return parsedCitation;
    });
    return {
      documentPath,
      title: stringValue(page.title, `pages[${pageIndex}].title`, 240),
      bodyMarkdown,
      bodySha256,
      revisionId,
      citations
    };
  });
  const ordered = canonicalContextPublicPages(pages);
  if (
    new Set(pages.map((page) => page.documentPath)).size !== pages.length ||
    pages.some((page, index) => page.documentPath !== ordered[index]?.documentPath)
  ) {
    throw invalidRelease("context release pages must be uniquely ordered by documentPath");
  }
  if (contextPublicSnapshotDigest(pages) !== publicSnapshotDigest) {
    throw invalidRelease("context release public snapshot digest mismatch");
  }
  const scope: BoardContextPublicationScope = {
    tenantId: release.tenantId,
    repository: release.repository,
    ref: release.ref,
    refSequence: release.refSequence,
    commitSha: release.commitSha,
    buildId: release.buildId
  };
  const recomputedInputDigest = boardContextPublicationInputDigest({
    scope,
    certificationArtifact,
    publicationPlanArtifact,
    checkpointId: release.checkpointId,
    publicSnapshotDigest,
    pages: pages.map((page) => ({
      documentPath: page.documentPath,
      bodySha256: page.bodySha256,
      revisionId: page.revisionId,
      citationIds: page.citations.map((citation) => citation.id)
    }))
  });
  if (
    recomputedInputDigest !== publicationInputDigest ||
    boardContextReleaseId(publicationInputDigest) !== release.releaseId
  ) {
    throw invalidRelease("context release publication identity mismatch");
  }
  return {
    version: 1,
    release,
    certificationArtifact,
    publicationPlanArtifact,
    publicSnapshotDigest,
    publicationInputDigest,
    pages
  };
}

export function parseContextPriorReleaseSeed(value: unknown): ContextPriorReleaseSeed {
  const input = objectValue(value, "prior Context release seed");
  if (input.version !== 1) throw invalidRelease("prior Context release seed version must be 1");
  const tenantId = stringValue(input.tenantId, "prior tenantId", 240);
  const repository = normalizeRepository(stringValue(input.repository, "prior repository", 512));
  const ref = stringValue(input.ref, "prior ref", 512);
  const refSequence = integerValue(input.refSequence, "prior refSequence", 1);
  const commitSha = stringValue(input.commitSha, "prior commitSha", 40).toLowerCase();
  const releaseId = stringValue(input.releaseId, "prior releaseId", 240);
  const publicSnapshotDigest = digestValue(input.publicSnapshotDigest, "prior publicSnapshotDigest");
  const releaseArtifact = artifactRefValue(input.releaseArtifact, "prior releaseArtifact");
  if (!isFullCommitSha(commitSha)) throw invalidRelease("prior commitSha must be a full Git SHA");
  if (
    releaseArtifact.contentType !== "application/json" ||
    !isContextArtifactKeyInRepositoryScope(releaseArtifact.key, { tenantId, repository }) ||
    !releaseArtifact.key.includes("/context-release/") ||
    !releaseArtifact.key.endsWith(`/${encodeURIComponent(releaseId)}.json`)
  ) {
    throw invalidRelease("prior release artifact is outside its immutable repository release scope");
  }
  return {
    version: 1,
    tenantId,
    repository,
    ref,
    refSequence,
    commitSha,
    releaseId,
    publicSnapshotDigest,
    releaseArtifact
  };
}

export function assertContextPriorReleaseMatches(
  seedValue: ContextPriorReleaseSeed,
  release: CertifiedContextReleaseArtifactV1
): void {
  const seed = parseContextPriorReleaseSeed(seedValue);
  if (
    release.release.releaseId !== seed.releaseId ||
    release.release.tenantId !== seed.tenantId ||
    release.release.repository !== seed.repository ||
    release.release.ref !== seed.ref ||
    release.release.refSequence !== seed.refSequence ||
    release.release.commitSha !== seed.commitSha ||
    release.publicSnapshotDigest !== seed.publicSnapshotDigest
  ) {
    throw invalidRelease("prior release bytes do not match the Board-bound seed identity");
  }
}

function artifactIdentity(ref: ContextArtifactRef): Record<string, unknown> {
  return {
    key: ref.key,
    sha256: ref.sha256,
    bytes: ref.bytes,
    contentType: ref.contentType,
    ...(ref.objectGeneration ? { objectGeneration: ref.objectGeneration } : {})
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRelease(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw invalidRelease(`${label} is invalid`);
  }
  return value;
}

function integerValue(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw invalidRelease(`${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function digestValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw invalidRelease(`${label} must be SHA-256`);
  }
  return value;
}

function publicPagePath(value: unknown, label: string): string {
  const path = stringValue(value, label, 512);
  if (
    path.startsWith("/") ||
    !path.endsWith(".md") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw invalidRelease(`${label} is not a safe public Markdown path`);
  }
  return path;
}

function artifactRefValue(value: unknown, label: string): ContextArtifactRef {
  const input = objectValue(value, label);
  const ref = {
    uri: stringValue(input.uri, `${label}.uri`, 4_096),
    key: stringValue(input.key, `${label}.key`, 4_096),
    contentType: stringValue(input.contentType, `${label}.contentType`, 240),
    bytes: integerValue(input.bytes, `${label}.bytes`, 0),
    sha256: digestValue(input.sha256, `${label}.sha256`),
    ...(input.objectGeneration === undefined
      ? {}
      : { objectGeneration: stringValue(input.objectGeneration, `${label}.objectGeneration`, 240) })
  };
  return ref;
}

function invalidRelease(message: string): BoardContextPublicationError {
  return new BoardContextPublicationError("invalid_publication", message);
}
