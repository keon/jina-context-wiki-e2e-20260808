import { createHash } from "node:crypto";
import {
  PAGEINDEX_OSS_ADAPTER_NAME,
  PAGEINDEX_OSS_SOURCE_DIGEST,
  PAGEINDEX_OSS_SOURCE_PIN,
  boardContextPublicationInputDigest,
  boardContextReleaseId,
  canonicalContextPublicPages,
  canonicalJson,
  contextPublicSnapshotDigest,
  fingerprint,
  isFullCommitSha,
  normalizeIsoTime,
  normalizeRepository,
  parseCertifiedContextReleaseArtifact,
  repositoryAclFingerprint,
  validateEvidenceAnchor,
  type EvidenceAnchor,
  type LocalPageIndexClient
} from "@jina/context-engine";

const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DOCUMENT_CHARACTERS = 2_000_000;
const DEFAULT_MAX_NODES = 20_000;
const MAX_RELEASE_DOCUMENTS = 96;
const MAX_DIAGNOSTICS = 32;
const MAX_NODE_TITLE = 1_000;
const MAX_NODE_SUMMARY = 4_000;

interface ReleaseArtifactRef {
  readonly uri: string;
  readonly key: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly objectGeneration?: string;
}

interface CertifiedReleaseCitation {
  readonly id: string;
  readonly revisionId: string;
  readonly ordinal: number;
  readonly claim: string;
  readonly citationId?: string;
  readonly claimSpan?: string;
  readonly anchor: EvidenceAnchor;
}

interface CertifiedReleasePage {
  readonly documentPath: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly bodySha256: string;
  readonly revisionId: string;
  readonly citations: readonly CertifiedReleaseCitation[];
}

interface CertifiedRelease {
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
  readonly certificationArtifact: ReleaseArtifactRef;
  readonly publicationPlanArtifact: ReleaseArtifactRef;
  readonly publicSnapshotDigest: string;
  readonly publicationInputDigest: string;
  readonly pages: readonly CertifiedReleasePage[];
}

interface PageIndexBuildDocument {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly anchors: EvidenceAnchor[];
  readonly aclFingerprint: string;
}

interface PageIndexTreeNode {
  readonly externalId: string;
  readonly documentId: string;
  readonly parentExternalId?: string;
  readonly title: string;
  readonly summary: string;
  readonly depth: number;
  readonly preorderStart: number;
  readonly preorderEnd: number;
  readonly anchors: readonly EvidenceAnchor[];
}

interface PageIndexBuildResult {
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly sourcePin: string;
  readonly sourceDigest: string;
  readonly nodes: readonly PageIndexTreeNode[];
  readonly diagnostics: readonly string[];
}

export type BoardPageIndexErrorCode =
  "invalid_release" | "worker_unavailable" | "version_mismatch" | "invalid_tree" | "incomplete_tree" | "worker_timeout";

export class BoardPageIndexError extends Error {
  constructor(
    readonly code: BoardPageIndexErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message.slice(0, 2_000), options);
    this.name = "BoardPageIndexError";
  }
}

interface PageIndexTreeArtifactV1 {
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
    readonly publicSnapshotDigest: string;
    readonly publicationInputDigest: string;
  };
  readonly source: {
    readonly adapterName: typeof PAGEINDEX_OSS_ADAPTER_NAME;
    readonly adapterVersion: typeof PAGEINDEX_OSS_SOURCE_PIN;
    readonly sourcePin: typeof PAGEINDEX_OSS_SOURCE_PIN;
    readonly sourceDigest: typeof PAGEINDEX_OSS_SOURCE_DIGEST;
  };
  readonly representedDocuments: readonly {
    readonly documentId: string;
    readonly documentPath: string;
    readonly title: string;
    readonly rootCount: number;
    readonly nodeCount: number;
    readonly maxDepth: number;
  }[];
  readonly metrics: {
    readonly documentCount: number;
    readonly representedDocumentCount: number;
    readonly rootCount: number;
    readonly nodeCount: number;
    readonly maxDepth: number;
    readonly documentCharacters: number;
    readonly inputDigest: string;
    readonly treeDigest: string;
    readonly buildDigest: string;
  };
  readonly nodes: readonly PageIndexTreeNode[];
  readonly diagnostics: readonly string[];
}

/**
 * Small result that may be attached to a release record or board event. The
 * complete tree remains in the immutable artifact.
 */
interface BoardPageIndexReleaseMetadata {
  readonly releaseId: string;
  readonly publicSnapshotDigest: string;
  readonly adapterName: typeof PAGEINDEX_OSS_ADAPTER_NAME;
  readonly adapterVersion: typeof PAGEINDEX_OSS_SOURCE_PIN;
  readonly sourcePin: typeof PAGEINDEX_OSS_SOURCE_PIN;
  readonly sourceDigest: typeof PAGEINDEX_OSS_SOURCE_DIGEST;
  readonly documentCount: number;
  readonly rootCount: number;
  readonly nodeCount: number;
  readonly maxDepth: number;
  readonly buildDigest: string;
  readonly artifactSha256: string;
}

export interface BoardPageIndexExecution {
  readonly artifact: PageIndexTreeArtifactV1;
  /** Canonical immutable bytes suitable for a `pageindex-tree` artifact. */
  readonly artifactContent: string;
  readonly artifactSha256: string;
  readonly releaseMetadata: BoardPageIndexReleaseMetadata;
}

export interface BoardPageIndexLimits {
  readonly timeoutMs?: number;
  readonly maxDocumentCharacters?: number;
  readonly maxNodes?: number;
}

/**
 * Builds one PageIndex tree from one already-published, certified Context
 * release. The input type intentionally has no repository snapshot, provider
 * payload, prompt, transcript, or GitHub credential, so none can cross the
 * PageIndex process boundary.
 */
export async function buildBoardPageIndex(
  client: LocalPageIndexClient,
  releaseValue: unknown,
  limits: BoardPageIndexLimits = {}
): Promise<BoardPageIndexExecution> {
  const normalizedLimits = validatedLimits(limits);
  let sharedValidatedRelease: unknown;
  try {
    sharedValidatedRelease = parseCertifiedContextReleaseArtifact(releaseValue);
  } catch (error) {
    throw new BoardPageIndexError("invalid_release", "published Context release contract is invalid", {
      cause: error
    });
  }
  const release = parseCertifiedRelease(sharedValidatedRelease, normalizedLimits.maxDocumentCharacters);

  const probe = await client.probe();
  if (!probe.available) {
    throw new BoardPageIndexError(
      probe.reason?.includes("timed out") ? "worker_timeout" : "worker_unavailable",
      `self-hosted PageIndex worker is unavailable: ${probe.reason ?? "probe failed"}`
    );
  }
  assertPinnedSource(probe, "probe");

  const pages = canonicalContextPublicPages(release.pages);
  const documents = pages.map((page) => hierarchyDocument(release, page));
  const hierarchyInput = {
    tenantId: release.release.tenantId,
    repository: release.release.repository,
    ref: release.release.ref,
    commitSha: release.release.commitSha,
    generationId: release.release.releaseId,
    documents,
    adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
    limits: normalizedLimits
  };
  const inputDigest = fingerprint({
    version: 1,
    releaseId: release.release.releaseId,
    publicSnapshotDigest: release.publicSnapshotDigest,
    sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
    sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST,
    documents: pages.map((page, index) => ({
      id: documents[index]!.id,
      documentPath: page.documentPath,
      title: page.title,
      bodySha256: page.bodySha256,
      anchors: documents[index]!.anchors.map((anchor) => fingerprint(anchor))
    })),
    limits: {
      maxDocumentCharacters: normalizedLimits.maxDocumentCharacters,
      maxNodes: normalizedLimits.maxNodes
    }
  });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, normalizedLimits.timeoutMs);
  let rawResult: unknown;
  try {
    rawResult = await client.build(hierarchyInput, controller.signal);
  } catch (error) {
    if (timedOut || (error instanceof Error && /timed out|abort/i.test(error.message))) {
      throw new BoardPageIndexError("worker_timeout", "self-hosted PageIndex build timed out", {
        cause: error
      });
    }
    throw new BoardPageIndexError("worker_unavailable", "self-hosted PageIndex build failed", {
      cause: error
    });
  } finally {
    clearTimeout(timer);
  }
  const result = parsePageIndexBuildResult(rawResult);
  assertPinnedSource(result, "build");
  const nodes = validateAndNormalizeTree(documents, result.nodes, normalizedLimits.maxNodes);
  const diagnostics = validatedDiagnostics(result.diagnostics);
  const treeDigest = fingerprint(nodes);
  const buildDigest = fingerprint({
    version: 1,
    releaseId: release.release.releaseId,
    publicSnapshotDigest: release.publicSnapshotDigest,
    inputDigest,
    treeDigest,
    adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
    adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
    sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
    sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST
  });
  const representedDocuments = pages.map((page, index) => {
    const documentId = documents[index]!.id;
    const documentNodes = nodes.filter((node) => node.documentId === documentId);
    return {
      documentId,
      documentPath: page.documentPath,
      title: page.title,
      rootCount: documentNodes.filter((node) => node.parentExternalId === undefined).length,
      nodeCount: documentNodes.length,
      maxDepth: Math.max(...documentNodes.map((node) => node.depth))
    };
  });
  const artifact: PageIndexTreeArtifactV1 = {
    version: 1,
    release: {
      ...release.release,
      publicSnapshotDigest: release.publicSnapshotDigest,
      publicationInputDigest: release.publicationInputDigest
    },
    source: {
      adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
      adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
      sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
      sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST
    },
    representedDocuments,
    metrics: {
      documentCount: documents.length,
      representedDocumentCount: representedDocuments.length,
      rootCount: representedDocuments.reduce((total, document) => total + document.rootCount, 0),
      nodeCount: nodes.length,
      maxDepth: Math.max(...representedDocuments.map((document) => document.maxDepth)),
      documentCharacters: pages.reduce((total, page) => total + page.bodyMarkdown.length, 0),
      inputDigest,
      treeDigest,
      buildDigest
    },
    nodes,
    diagnostics
  };
  const artifactContent = `${canonicalJson(artifact)}\n`;
  const artifactSha256 = createHash("sha256").update(artifactContent).digest("hex");
  return {
    artifact,
    artifactContent,
    artifactSha256,
    releaseMetadata: {
      releaseId: release.release.releaseId,
      publicSnapshotDigest: release.publicSnapshotDigest,
      adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
      adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
      sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
      sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST,
      documentCount: artifact.metrics.documentCount,
      rootCount: artifact.metrics.rootCount,
      nodeCount: artifact.metrics.nodeCount,
      maxDepth: artifact.metrics.maxDepth,
      buildDigest,
      artifactSha256
    }
  };
}

function validatedLimits(input: BoardPageIndexLimits): Required<BoardPageIndexLimits> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDocumentCharacters = input.maxDocumentCharacters ?? DEFAULT_MAX_DOCUMENT_CHARACTERS;
  const maxNodes = input.maxNodes ?? DEFAULT_MAX_NODES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300_000) {
    throw new BoardPageIndexError("invalid_release", "PageIndex timeout must be between 10 and 300000ms");
  }
  if (
    !Number.isSafeInteger(maxDocumentCharacters) ||
    maxDocumentCharacters < 1_000 ||
    maxDocumentCharacters > 10_000_000
  ) {
    throw new BoardPageIndexError("invalid_release", "PageIndex document character limit is invalid");
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 100_000) {
    throw new BoardPageIndexError("invalid_release", "PageIndex node limit is invalid");
  }
  return { timeoutMs, maxDocumentCharacters, maxNodes };
}

function parseCertifiedRelease(value: unknown, maxDocumentCharacters: number): CertifiedRelease {
  const artifact = requiredRecord(value, "release artifact");
  if (artifact.version !== 1) invalidRelease("release version must be 1");
  const releaseValue = requiredRecord(artifact.release, "release identity");
  const release: CertifiedRelease["release"] = {
    releaseId: requiredString(releaseValue.releaseId, "releaseId"),
    tenantId: requiredString(releaseValue.tenantId, "tenantId"),
    repository: requiredString(releaseValue.repository, "repository"),
    ref: requiredString(releaseValue.ref, "ref"),
    refSequence: requiredInteger(releaseValue.refSequence, "refSequence"),
    commitSha: requiredString(releaseValue.commitSha, "commitSha"),
    checkpointId: requiredString(releaseValue.checkpointId, "checkpointId"),
    buildId: requiredString(releaseValue.buildId, "buildId"),
    publishedAt: requiredString(releaseValue.publishedAt, "publishedAt")
  };
  if (!release.releaseId.trim() || !release.tenantId.trim() || !release.ref.trim() || !release.checkpointId.trim()) {
    invalidRelease("release identity is incomplete");
  }
  let normalizedRepository: string;
  try {
    normalizedRepository = normalizeRepository(release.repository);
  } catch (error) {
    throw new BoardPageIndexError("invalid_release", "release repository is invalid", { cause: error });
  }
  if (normalizedRepository !== release.repository) {
    invalidRelease("release repository must be normalized");
  }
  if (!isFullCommitSha(release.commitSha)) invalidRelease("release commit SHA is invalid");
  if (!Number.isSafeInteger(release.refSequence) || release.refSequence < 1) {
    invalidRelease("release ref sequence is invalid");
  }
  let normalizedPublishedAt: string;
  try {
    normalizedPublishedAt = normalizeIsoTime(release.publishedAt);
  } catch (error) {
    throw new BoardPageIndexError("invalid_release", "release publication time is invalid", { cause: error });
  }
  if (normalizedPublishedAt !== release.publishedAt) {
    invalidRelease("release publication time must be normalized");
  }
  const publicSnapshotDigest = requiredString(artifact.publicSnapshotDigest, "publicSnapshotDigest");
  const publicationInputDigest = requiredString(artifact.publicationInputDigest, "publicationInputDigest");
  if (!SHA256.test(publicSnapshotDigest) || !SHA256.test(publicationInputDigest)) {
    invalidRelease("release digest is invalid");
  }
  const certificationArtifact = parseArtifactRef(artifact.certificationArtifact, "certification artifact");
  const publicationPlanArtifact = parseArtifactRef(artifact.publicationPlanArtifact, "publication plan artifact");
  validateScopedArtifactRef(certificationArtifact, release, "certification", "certification artifact");
  validateScopedArtifactRef(publicationPlanArtifact, release, "publication-plan", "publication plan artifact");
  if (!Array.isArray(artifact.pages) || artifact.pages.length === 0 || artifact.pages.length > MAX_RELEASE_DOCUMENTS) {
    invalidRelease(`release must contain between 1 and ${MAX_RELEASE_DOCUMENTS} pages`);
  }
  const pages = artifact.pages.map((page, index) => parseReleasePage(page, release, maxDocumentCharacters, index));
  const paths = new Set<string>();
  const revisions = new Set<string>();
  for (const page of pages) {
    if (paths.has(page.documentPath)) invalidRelease("release contains duplicate document paths");
    if (revisions.has(page.revisionId)) invalidRelease("release contains duplicate revision IDs");
    paths.add(page.documentPath);
    revisions.add(page.revisionId);
  }
  const parsed: CertifiedRelease = {
    version: 1,
    release,
    certificationArtifact,
    publicationPlanArtifact,
    publicSnapshotDigest,
    publicationInputDigest,
    pages
  };
  if (parsed.publicSnapshotDigest !== contextPublicSnapshotDigest(parsed.pages)) {
    throw new BoardPageIndexError(
      "invalid_release",
      "release public snapshot digest does not match its exact page bytes"
    );
  }
  const expectedInputDigest = boardContextPublicationInputDigest({
    scope: {
      tenantId: release.tenantId,
      repository: release.repository,
      ref: release.ref,
      refSequence: release.refSequence,
      commitSha: release.commitSha,
      buildId: release.buildId
    },
    certificationArtifact: parsed.certificationArtifact,
    publicationPlanArtifact: parsed.publicationPlanArtifact,
    checkpointId: release.checkpointId,
    publicSnapshotDigest: parsed.publicSnapshotDigest,
    pages: parsed.pages.map((page) => ({
      documentPath: page.documentPath,
      bodySha256: page.bodySha256,
      revisionId: page.revisionId,
      citationIds: page.citations.map((citation) => citation.id)
    }))
  });
  if (parsed.publicationInputDigest !== expectedInputDigest) {
    invalidRelease("release publication input digest does not match its certified manifest");
  }
  if (release.releaseId !== boardContextReleaseId(expectedInputDigest)) {
    invalidRelease("release ID does not match its certified publication input");
  }
  return parsed;
}

function parseReleasePage(
  value: unknown,
  release: CertifiedRelease["release"],
  maxDocumentCharacters: number,
  index: number
): CertifiedReleasePage {
  const input = requiredRecord(value, `pages[${index}]`);
  const page: CertifiedReleasePage = {
    documentPath: requiredString(input.documentPath, `pages[${index}].documentPath`),
    title: requiredString(input.title, `pages[${index}].title`),
    bodyMarkdown: requiredString(input.bodyMarkdown, `pages[${index}].bodyMarkdown`),
    bodySha256: requiredString(input.bodySha256, `pages[${index}].bodySha256`),
    revisionId: requiredString(input.revisionId, `pages[${index}].revisionId`),
    citations: parseCitations(input.citations, release, index)
  };
  if (
    !page.documentPath.endsWith(".md") ||
    page.documentPath.startsWith("/") ||
    page.documentPath.includes("\\") ||
    page.documentPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    invalidRelease("release contains an invalid document path");
  }
  if (!page.title.trim() || page.title.length > 1_000 || !page.bodyMarkdown.trim()) {
    invalidRelease(`release page ${page.documentPath} has invalid public content`);
  }
  if (page.bodyMarkdown.length > maxDocumentCharacters) {
    invalidRelease(`release page ${page.documentPath} exceeds the PageIndex character limit`);
  }
  if (!page.revisionId.trim() || page.revisionId.length > 240) {
    invalidRelease(`release page ${page.documentPath} has an invalid revision ID`);
  }
  if (page.bodySha256 !== fingerprint(page.bodyMarkdown)) {
    invalidRelease(`release page ${page.documentPath} body digest does not match its bytes`);
  }
  if (page.citations.some((citation) => citation.revisionId !== page.revisionId)) {
    invalidRelease(`release page ${page.documentPath} contains a citation outside its revision`);
  }
  return page;
}

function parseCitations(
  value: unknown,
  release: CertifiedRelease["release"],
  pageIndex: number
): CertifiedReleaseCitation[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalidRelease(`release page ${pageIndex} has no certified citations`);
  }
  const citations = value.map((citationValue, citationIndex) => {
    const input = requiredRecord(citationValue, `pages[${pageIndex}].citations[${citationIndex}]`);
    const citation: CertifiedReleaseCitation = {
      id: requiredString(input.id, "citation.id"),
      revisionId: requiredString(input.revisionId, "citation.revisionId"),
      ordinal: requiredInteger(input.ordinal, "citation.ordinal"),
      claim: requiredString(input.claim, "citation.claim"),
      ...(input.citationId === undefined
        ? {}
        : { citationId: requiredString(input.citationId, "citation.citationId") }),
      ...(input.claimSpan === undefined ? {} : { claimSpan: requiredString(input.claimSpan, "citation.claimSpan") }),
      anchor: parseEvidenceAnchor(input.anchor)
    };
    return citation;
  });
  const citationIds = new Set<string>();
  for (const citation of citations) {
    if (!citation.id.trim() || citationIds.has(citation.id)) {
      invalidRelease(`release page ${pageIndex} contains an invalid citation identity`);
    }
    citationIds.add(citation.id);
    if (!Number.isSafeInteger(citation.ordinal) || citation.ordinal < 0) {
      invalidRelease(`release page ${pageIndex} contains an invalid citation ordinal`);
    }
    if (!citation.claim.trim()) invalidRelease(`release page ${pageIndex} contains an empty citation claim`);
    const anchor = citation.anchor;
    if (anchor.tenantId !== release.tenantId || anchor.repository !== release.repository) {
      invalidRelease(`release page ${pageIndex} contains a cross-scope citation`);
    }
  }
  return citations;
}

function validateScopedArtifactRef(
  artifact: ReleaseArtifactRef,
  release: CertifiedRelease["release"],
  kind: string,
  label: string
): void {
  if (
    !artifact ||
    !artifact.uri.trim() ||
    artifact.contentType !== "application/json" ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 1 ||
    !SHA256.test(artifact.sha256)
  ) {
    invalidRelease(`${label} is invalid`);
  }
  const scopePrefix = [
    "context-v2",
    "tenants",
    encodeURIComponent(release.tenantId),
    "repositories",
    ...release.repository.split("/").map(encodeURIComponent),
    "builds",
    encodeURIComponent(release.buildId),
    kind
  ].join("/");
  if (!artifact.key.startsWith(`${scopePrefix}/`)) {
    invalidRelease(`${label} is outside the release build scope`);
  }
}

function parseArtifactRef(value: unknown, label: string): ReleaseArtifactRef {
  const input = requiredRecord(value, label);
  return {
    uri: requiredString(input.uri, `${label}.uri`),
    key: requiredString(input.key, `${label}.key`),
    contentType: requiredString(input.contentType, `${label}.contentType`),
    bytes: requiredInteger(input.bytes, `${label}.bytes`),
    sha256: requiredString(input.sha256, `${label}.sha256`),
    ...(input.objectGeneration === undefined
      ? {}
      : { objectGeneration: requiredString(input.objectGeneration, `${label}.objectGeneration`) })
  };
}

function parseEvidenceAnchor(value: unknown): EvidenceAnchor {
  const input = requiredRecord(value, "citation.anchor");
  const sourceType = requiredString(input.sourceType, "citation.anchor.sourceType");
  if (!["observation", "blob", "commit", "pull_request", "issue", "document"].includes(sourceType)) {
    invalidRelease("citation anchor source type is invalid");
  }
  const anchor: EvidenceAnchor = {
    tenantId: requiredString(input.tenantId, "citation.anchor.tenantId"),
    repository: requiredString(input.repository, "citation.anchor.repository"),
    sourceType: sourceType as EvidenceAnchor["sourceType"],
    sourceId: requiredString(input.sourceId, "citation.anchor.sourceId"),
    contentDigest: requiredString(input.contentDigest, "citation.anchor.contentDigest"),
    ...(input.commitSha === undefined
      ? {}
      : { commitSha: requiredString(input.commitSha, "citation.anchor.commitSha") }),
    ...(input.pathOrUrl === undefined
      ? {}
      : { pathOrUrl: requiredString(input.pathOrUrl, "citation.anchor.pathOrUrl") }),
    ...(input.startLine === undefined
      ? {}
      : { startLine: requiredInteger(input.startLine, "citation.anchor.startLine") }),
    ...(input.endLine === undefined ? {} : { endLine: requiredInteger(input.endLine, "citation.anchor.endLine") }),
    ...(input.jsonPointer === undefined
      ? {}
      : { jsonPointer: jsonPointerString(input.jsonPointer, "citation.anchor.jsonPointer") }),
    ...(input.observedAt === undefined
      ? {}
      : { observedAt: requiredString(input.observedAt, "citation.anchor.observedAt") })
  };
  try {
    return validateEvidenceAnchor(anchor);
  } catch (error) {
    throw new BoardPageIndexError("invalid_release", "release contains an invalid citation anchor", {
      cause: error
    });
  }
}

function jsonPointerString(value: unknown, label: string): string {
  if (typeof value !== "string") invalidRelease(`${label} must be a string`);
  return value;
}

function hierarchyDocument(release: CertifiedRelease, page: CertifiedReleasePage): PageIndexBuildDocument {
  const anchorsByDigest = new Map<string, EvidenceAnchor>();
  for (const citation of page.citations) {
    anchorsByDigest.set(fingerprint(citation.anchor), citation.anchor);
  }
  return {
    id: page.revisionId,
    title: page.title,
    body: page.bodyMarkdown,
    anchors: [...anchorsByDigest.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, anchor]) => anchor),
    aclFingerprint: repositoryAclFingerprint(release.release.tenantId, release.release.repository)
  };
}

function assertPinnedSource(
  value: {
    readonly adapterName?: string;
    readonly adapterVersion?: string;
    readonly sourcePin?: string;
    readonly sourceDigest?: string;
  },
  stage: string
): void {
  if (
    value.adapterName !== PAGEINDEX_OSS_ADAPTER_NAME ||
    value.adapterVersion !== PAGEINDEX_OSS_SOURCE_PIN ||
    value.sourcePin !== PAGEINDEX_OSS_SOURCE_PIN ||
    value.sourceDigest !== PAGEINDEX_OSS_SOURCE_DIGEST
  ) {
    throw new BoardPageIndexError(
      "version_mismatch",
      `self-hosted PageIndex ${stage} did not attest the pinned source ${PAGEINDEX_OSS_SOURCE_PIN}`
    );
  }
}

function parsePageIndexBuildResult(value: unknown): PageIndexBuildResult {
  const input = requiredRecord(value, "PageIndex build result");
  if (!Array.isArray(input.nodes)) {
    throw new BoardPageIndexError("invalid_tree", "PageIndex build result has no node array");
  }
  const nodes = input.nodes.map((nodeValue, index): PageIndexTreeNode => {
    const node = requiredRecord(nodeValue, `PageIndex nodes[${index}]`);
    const anchorsValue = node.anchors;
    if (!Array.isArray(anchorsValue)) {
      throw new BoardPageIndexError("invalid_tree", "PageIndex node has no anchor array");
    }
    return {
      externalId: requiredTreeString(node.externalId, "node.externalId"),
      documentId: requiredTreeString(node.documentId, "node.documentId"),
      ...(node.parentExternalId === undefined
        ? {}
        : { parentExternalId: requiredTreeString(node.parentExternalId, "node.parentExternalId") }),
      title: requiredTreeString(node.title, "node.title"),
      summary: requiredTreeString(node.summary, "node.summary"),
      depth: requiredTreeInteger(node.depth, "node.depth"),
      preorderStart: requiredTreeInteger(node.preorderStart, "node.preorderStart"),
      preorderEnd: requiredTreeInteger(node.preorderEnd, "node.preorderEnd"),
      anchors: anchorsValue.map((anchor) => parseTreeAnchor(anchor))
    };
  });
  if (!Array.isArray(input.diagnostics)) {
    throw new BoardPageIndexError("invalid_tree", "PageIndex build result has no diagnostics array");
  }
  const diagnostics = input.diagnostics.map((diagnostic) => {
    if (typeof diagnostic !== "string") {
      throw new BoardPageIndexError("invalid_tree", "PageIndex returned a non-text diagnostic");
    }
    return diagnostic;
  });
  return {
    adapterName: requiredTreeString(input.adapterName, "adapterName"),
    adapterVersion: requiredTreeString(input.adapterVersion, "adapterVersion"),
    sourcePin: requiredTreeString(input.sourcePin, "sourcePin"),
    sourceDigest: requiredTreeString(input.sourceDigest, "sourceDigest"),
    nodes,
    diagnostics
  };
}

function parseTreeAnchor(value: unknown): EvidenceAnchor {
  try {
    return parseEvidenceAnchor(value);
  } catch (error) {
    throw new BoardPageIndexError("invalid_tree", "PageIndex returned an invalid source anchor", {
      cause: error
    });
  }
}

function validateAndNormalizeTree(
  documents: readonly PageIndexBuildDocument[],
  inputNodes: readonly PageIndexTreeNode[],
  maxNodes: number
): PageIndexTreeNode[] {
  if (inputNodes.length === 0 || inputNodes.length > maxNodes) {
    throw new BoardPageIndexError("invalid_tree", "PageIndex returned an invalid node count");
  }
  const documentOrder = new Map(documents.map((document, index) => [document.id, index]));
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const nodesById = new Map<string, PageIndexTreeNode>();
  for (const node of inputNodes) {
    if (
      !node ||
      typeof node.externalId !== "string" ||
      !node.externalId.trim() ||
      node.externalId.length > 512 ||
      nodesById.has(node.externalId)
    ) {
      throw new BoardPageIndexError("invalid_tree", "PageIndex returned a duplicate or empty node ID");
    }
    const document = documentsById.get(node.documentId);
    if (!document) throw new BoardPageIndexError("invalid_tree", "PageIndex node references an unknown document");
    if (
      typeof node.title !== "string" ||
      !node.title.trim() ||
      node.title.length > MAX_NODE_TITLE ||
      typeof node.summary !== "string" ||
      node.summary.length > MAX_NODE_SUMMARY ||
      !Number.isSafeInteger(node.depth) ||
      node.depth < 1 ||
      !Number.isSafeInteger(node.preorderStart) ||
      node.preorderStart < 1 ||
      !Number.isSafeInteger(node.preorderEnd) ||
      node.preorderEnd < node.preorderStart
    ) {
      throw new BoardPageIndexError("invalid_tree", "PageIndex returned malformed node fields");
    }
    if (!Array.isArray(node.anchors) || node.anchors.length === 0) {
      throw new BoardPageIndexError("invalid_tree", "PageIndex node has no certified source anchor");
    }
    const allowedAnchors = new Set(document.anchors.map((anchor: EvidenceAnchor) => fingerprint(anchor)));
    const returnedAnchors = new Set(node.anchors.map((anchor: EvidenceAnchor) => fingerprint(anchor)));
    if (
      returnedAnchors.size !== allowedAnchors.size ||
      [...returnedAnchors].some((anchor) => !allowedAnchors.has(anchor))
    ) {
      throw new BoardPageIndexError("invalid_tree", "PageIndex node anchor is outside the certified release");
    }
    nodesById.set(node.externalId, node);
  }

  for (const node of inputNodes) {
    if (node.parentExternalId === undefined) {
      if (node.depth !== 1) {
        throw new BoardPageIndexError("invalid_tree", "PageIndex root depth is invalid");
      }
      continue;
    }
    const parent = nodesById.get(node.parentExternalId);
    if (!parent || parent.documentId !== node.documentId) {
      throw new BoardPageIndexError("invalid_tree", "PageIndex node parent is missing or cross-document");
    }
    if (
      node.depth !== parent.depth + 1 ||
      node.preorderStart <= parent.preorderStart ||
      node.preorderEnd > parent.preorderEnd
    ) {
      throw new BoardPageIndexError("invalid_tree", "PageIndex child interval is inconsistent with its parent");
    }
  }

  for (const document of documents) {
    const documentNodes = inputNodes
      .filter((node) => node.documentId === document.id)
      .sort((left, right) => left.preorderStart - right.preorderStart);
    if (documentNodes.length === 0) {
      throw new BoardPageIndexError("incomplete_tree", `PageIndex omitted certified document ${document.id}`);
    }
    const starts = [...documentNodes].map((node) => node.preorderStart).sort((left, right) => left - right);
    if (starts.some((start, index) => start !== index + 1)) {
      throw new BoardPageIndexError("invalid_tree", "PageIndex document preorder is not contiguous");
    }
    const roots = documentNodes.filter((node) => node.parentExternalId === undefined);
    if (roots.length === 0) {
      throw new BoardPageIndexError("invalid_tree", "PageIndex document has no root");
    }
    const activeAncestors: PageIndexTreeNode[] = [];
    for (const node of documentNodes) {
      while (activeAncestors.length > 0 && node.preorderStart > activeAncestors.at(-1)!.preorderEnd) {
        activeAncestors.pop();
      }
      const expectedParent = activeAncestors.at(-1);
      if (
        (expectedParent === undefined && node.parentExternalId !== undefined) ||
        (expectedParent !== undefined && node.parentExternalId !== expectedParent.externalId)
      ) {
        throw new BoardPageIndexError("invalid_tree", "PageIndex preorder does not match its parent graph");
      }
      const descendantEnds = documentNodes
        .filter(
          (candidate) => candidate.preorderStart >= node.preorderStart && candidate.preorderStart <= node.preorderEnd
        )
        .map((candidate) => candidate.preorderStart);
      if (node.preorderEnd !== Math.max(...descendantEnds)) {
        throw new BoardPageIndexError("invalid_tree", "PageIndex node preorder interval is not exact");
      }
      activeAncestors.push(node);
    }
  }

  return [...inputNodes]
    .map((node) => ({
      externalId: node.externalId,
      documentId: node.documentId,
      ...(node.parentExternalId === undefined ? {} : { parentExternalId: node.parentExternalId }),
      title: node.title,
      summary: node.summary,
      depth: node.depth,
      preorderStart: node.preorderStart,
      preorderEnd: node.preorderEnd,
      anchors: [...node.anchors].sort((left, right) => fingerprint(left).localeCompare(fingerprint(right)))
    }))
    .sort(
      (left, right) =>
        documentOrder.get(left.documentId)! - documentOrder.get(right.documentId)! ||
        left.preorderStart - right.preorderStart ||
        left.externalId.localeCompare(right.externalId)
    );
}

function validatedDiagnostics(input: readonly string[]): string[] {
  if (input.length > MAX_DIAGNOSTICS) {
    throw new BoardPageIndexError("invalid_tree", "PageIndex returned invalid diagnostics");
  }
  return input.map((diagnostic) => {
    if (typeof diagnostic !== "string") {
      throw new BoardPageIndexError("invalid_tree", "PageIndex returned a non-text diagnostic");
    }
    return diagnostic.slice(0, 1_000);
  });
}

function invalidRelease(message: string): never {
  throw new BoardPageIndexError("invalid_release", message);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidRelease(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) invalidRelease(`${label} must be a non-empty string`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidRelease(`${label} must be an integer`);
  return value;
}

function requiredTreeString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BoardPageIndexError("invalid_tree", `PageIndex ${label} must be a string`);
  }
  return value;
}

function requiredTreeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new BoardPageIndexError("invalid_tree", `PageIndex ${label} must be an integer`);
  }
  return value;
}
