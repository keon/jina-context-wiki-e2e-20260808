import { createHash } from "node:crypto";
import type { EvidenceAnchor } from "../domain/evidence.js";
import { validateEvidenceAnchor } from "../domain/evidence.js";
import {
  canonicalJson,
  fingerprint,
  isFullCommitSha,
  normalizeIsoTime,
  normalizeRepository
} from "../domain/fingerprint.js";
import {
  PAGEINDEX_OSS_ADAPTER_NAME,
  PAGEINDEX_OSS_SOURCE_DIGEST,
  PAGEINDEX_OSS_SOURCE_PIN
} from "../index/pageindex-local-client.js";
import {
  contextArtifactScopePrefix,
  isContextArtifactKeyInScope,
  type ContextArtifactRef
} from "../ports/artifact-store.js";
import type { BoardContextPublicationScope, BoardPublicationLeaseFence } from "./board-publication.js";

const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_ID = /^cr_[0-9a-f]{32}$/;
const MAX_DOCUMENTS = 96;
const MAX_NODES = 100_000;
const MAX_TITLE = 1_000;
const MAX_SUMMARY = 4_000;
const MAX_DIAGNOSTICS = 32;

export interface BoardPageIndexTreeNode {
  readonly externalId: string;
  /** The immutable knowledge revision ID represented by this node. */
  readonly documentId: string;
  readonly parentExternalId?: string;
  readonly title: string;
  readonly summary: string;
  readonly depth: number;
  readonly preorderStart: number;
  readonly preorderEnd: number;
  readonly anchors: readonly EvidenceAnchor[];
}

export interface BoardPageIndexTreeArtifactV1 {
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
  readonly nodes: readonly BoardPageIndexTreeNode[];
  readonly diagnostics: readonly string[];
}

export interface BoardPageIndexAttachCommit {
  readonly scope: BoardContextPublicationScope;
  readonly lease: BoardPublicationLeaseFence;
  readonly releaseId: string;
  readonly releaseArtifactRef: ContextArtifactRef;
  readonly idempotencyKey: string;
  readonly attachmentInputDigest: string;
  readonly treeArtifactRef: ContextArtifactRef;
  readonly treeArtifact: BoardPageIndexTreeArtifactV1;
  readonly attachedAt: string;
}

export interface BoardPageIndexAttachmentRecord {
  readonly releaseId: string;
  readonly generationId: string;
  readonly attachmentInputDigest: string;
  readonly treeArtifactRef: ContextArtifactRef;
  readonly treeDigest: string;
  readonly buildDigest: string;
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly documentCount: number;
  readonly nodeCount: number;
  readonly maxDepth: number;
  readonly attachedAt: string;
}

export interface BoardPageIndexAttachmentTransactionPort {
  /**
   * Attaches the immutable hierarchy and, in the same fenced transaction,
   * makes the prepared release query-visible. The highest attached sequence is
   * current. Replaying the same immutable attachment is idempotent.
   */
  attachPageIndexAtomically(input: BoardPageIndexAttachCommit): Promise<BoardPageIndexAttachmentRecord>;
}

export type BoardPageIndexAttachmentErrorCode =
  | "invalid_pageindex_attachment"
  | "stale_pageindex_lease"
  | "stale_ref_sequence"
  | "release_not_current"
  | "idempotency_conflict"
  | "pageindex_conflict"
  | "attachment_race";

export class BoardPageIndexAttachmentError extends Error {
  constructor(
    readonly code: BoardPageIndexAttachmentErrorCode,
    message: string
  ) {
    super(message.slice(0, 2_000));
    this.name = "BoardPageIndexAttachmentError";
  }
}

export function serializeBoardPageIndexTreeArtifact(artifact: BoardPageIndexTreeArtifactV1): string {
  return `${canonicalJson(artifact)}\n`;
}

export function boardPageIndexAttachmentInputDigest(input: {
  readonly scope: BoardContextPublicationScope;
  readonly releaseId: string;
  readonly releaseArtifactRef: ContextArtifactRef;
  readonly treeArtifactRef: ContextArtifactRef;
  readonly treeDigest: string;
  readonly buildDigest: string;
}): string {
  return fingerprint({
    version: 1,
    scope: input.scope,
    releaseId: input.releaseId,
    releaseArtifactRef: artifactIdentity(input.releaseArtifactRef),
    treeArtifactRef: artifactIdentity(input.treeArtifactRef),
    treeDigest: input.treeDigest,
    buildDigest: input.buildDigest
  });
}

/**
 * Strict attachment boundary shared by the authoritative API and PostgreSQL
 * adapter. It validates the complete tree again after artifact upload.
 */
export function validateBoardPageIndexAttachCommit(input: BoardPageIndexAttachCommit): BoardPageIndexTreeArtifactV1 {
  const artifact = parseBoardPageIndexTreeArtifact(input.treeArtifact);
  const release = artifact.release;
  if (
    release.releaseId !== input.releaseId ||
    release.tenantId !== input.scope.tenantId ||
    release.repository !== input.scope.repository ||
    release.ref !== input.scope.ref ||
    release.refSequence !== input.scope.refSequence ||
    release.commitSha !== input.scope.commitSha ||
    release.buildId !== input.scope.buildId
  ) {
    invalid("PageIndex artifact escapes the leased release scope");
  }
  validateArtifactRef(input.treeArtifactRef, input.scope, "pageindex-tree");
  validateArtifactRef(input.releaseArtifactRef, input.scope, "context-release");
  const content = serializeBoardPageIndexTreeArtifact(artifact);
  if (
    input.treeArtifactRef.bytes !== Buffer.byteLength(content, "utf8") ||
    input.treeArtifactRef.sha256 !== createHash("sha256").update(content).digest("hex")
  ) {
    invalid("PageIndex artifact reference does not bind the exact canonical tree bytes");
  }
  const expectedInputDigest = boardPageIndexAttachmentInputDigest({
    scope: input.scope,
    releaseId: input.releaseId,
    releaseArtifactRef: input.releaseArtifactRef,
    treeArtifactRef: input.treeArtifactRef,
    treeDigest: artifact.metrics.treeDigest,
    buildDigest: artifact.metrics.buildDigest
  });
  if (input.attachmentInputDigest !== expectedInputDigest) {
    invalid("PageIndex attachment digest does not match the exact release and artifact");
  }
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 1_000) {
    invalid("PageIndex idempotency key is invalid");
  }
  let attachedAt: string;
  try {
    attachedAt = normalizeIsoTime(input.attachedAt);
  } catch {
    invalid("PageIndex attachment time is invalid");
  }
  if (attachedAt !== input.attachedAt) {
    invalid("PageIndex attachment time must be normalized");
  }
  return artifact;
}

export function parseBoardPageIndexTreeArtifact(value: unknown): BoardPageIndexTreeArtifactV1 {
  const input = record(value, "PageIndex tree artifact");
  if (input.version !== 1) invalid("PageIndex tree artifact version must be 1");
  const releaseInput = record(input.release, "PageIndex release");
  const repositoryInput = text(releaseInput.repository, "repository", 512);
  const publishedAtInput = text(releaseInput.publishedAt, "publishedAt", 64);
  let repository: string;
  let publishedAt: string;
  try {
    repository = normalizeRepository(repositoryInput);
    publishedAt = normalizeIsoTime(publishedAtInput);
  } catch {
    invalid("PageIndex release repository or publication time is invalid");
  }
  if (repository !== repositoryInput || publishedAt !== publishedAtInput) {
    invalid("PageIndex release identity must be canonical");
  }
  const release = {
    releaseId: text(releaseInput.releaseId, "releaseId", 240),
    tenantId: text(releaseInput.tenantId, "tenantId", 240),
    repository,
    ref: text(releaseInput.ref, "ref", 512),
    refSequence: integer(releaseInput.refSequence, "refSequence", 1),
    commitSha: text(releaseInput.commitSha, "commitSha", 40).toLowerCase(),
    checkpointId: text(releaseInput.checkpointId, "checkpointId", 240),
    buildId: text(releaseInput.buildId, "buildId", 240),
    publishedAt,
    publicSnapshotDigest: digest(releaseInput.publicSnapshotDigest, "publicSnapshotDigest"),
    publicationInputDigest: digest(releaseInput.publicationInputDigest, "publicationInputDigest")
  };
  if (!RELEASE_ID.test(release.releaseId) || !isFullCommitSha(release.commitSha)) {
    invalid("PageIndex release identity is invalid");
  }

  const sourceInput = record(input.source, "PageIndex source");
  if (
    sourceInput.adapterName !== PAGEINDEX_OSS_ADAPTER_NAME ||
    sourceInput.adapterVersion !== PAGEINDEX_OSS_SOURCE_PIN ||
    sourceInput.sourcePin !== PAGEINDEX_OSS_SOURCE_PIN ||
    sourceInput.sourceDigest !== PAGEINDEX_OSS_SOURCE_DIGEST
  ) {
    invalid("PageIndex source does not match the pinned self-hosted implementation");
  }
  const source: BoardPageIndexTreeArtifactV1["source"] = {
    adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
    adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
    sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
    sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST
  };

  if (
    !Array.isArray(input.representedDocuments) ||
    input.representedDocuments.length < 1 ||
    input.representedDocuments.length > MAX_DOCUMENTS
  ) {
    invalid("PageIndex represented document count is invalid");
  }
  const representedDocuments = input.representedDocuments.map((value, index) => {
    const document = record(value, `representedDocuments[${index}]`);
    return {
      documentId: text(document.documentId, "documentId", 240),
      documentPath: documentPath(document.documentPath),
      title: text(document.title, "document title", MAX_TITLE),
      rootCount: integer(document.rootCount, "rootCount", 1),
      nodeCount: integer(document.nodeCount, "nodeCount", 1),
      maxDepth: integer(document.maxDepth, "maxDepth", 1)
    };
  });
  if (
    new Set(representedDocuments.map((document) => document.documentId)).size !== representedDocuments.length ||
    new Set(representedDocuments.map((document) => document.documentPath)).size !== representedDocuments.length ||
    representedDocuments.some(
      (document, index) =>
        index > 0 && representedDocuments[index - 1]!.documentPath.localeCompare(document.documentPath) >= 0
    )
  ) {
    invalid("PageIndex represented documents are duplicate or non-canonical");
  }

  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > MAX_NODES) {
    invalid("PageIndex node count is invalid");
  }
  const nodes = input.nodes.map((value, index): BoardPageIndexTreeNode => {
    const node = record(value, `nodes[${index}]`);
    if (!Array.isArray(node.anchors) || node.anchors.length < 1) {
      invalid(`PageIndex node ${index} has no anchors`);
    }
    const anchors = node.anchors.map((anchor) => {
      try {
        const parsed = validateEvidenceAnchor(record(anchor, `nodes[${index}].anchor`) as unknown as EvidenceAnchor);
        if (
          parsed.tenantId !== release.tenantId ||
          parsed.repository !== release.repository ||
          (parsed.commitSha !== undefined && parsed.commitSha !== release.commitSha)
        ) {
          invalid(`PageIndex node ${index} has an anchor outside the release`);
        }
        return parsed;
      } catch (error) {
        if (error instanceof BoardPageIndexAttachmentError) throw error;
        throw new BoardPageIndexAttachmentError(
          "invalid_pageindex_attachment",
          `PageIndex node ${index} has an invalid anchor: ${bounded(error)}`
        );
      }
    });
    if (
      anchors.some(
        (anchor, anchorIndex) =>
          anchorIndex > 0 && fingerprint(anchors[anchorIndex - 1]!).localeCompare(fingerprint(anchor)) >= 0
      )
    ) {
      invalid(`PageIndex node ${index} anchors are duplicate or non-canonical`);
    }
    return {
      externalId: text(node.externalId, "externalId", 512),
      documentId: text(node.documentId, "documentId", 240),
      ...(node.parentExternalId === undefined
        ? {}
        : { parentExternalId: text(node.parentExternalId, "parentExternalId", 512) }),
      title: text(node.title, "node title", MAX_TITLE),
      summary: optionalText(node.summary, "node summary", MAX_SUMMARY),
      depth: integer(node.depth, "node depth", 1),
      preorderStart: integer(node.preorderStart, "preorderStart", 1),
      preorderEnd: integer(node.preorderEnd, "preorderEnd", 1),
      anchors
    };
  });
  validateTree(nodes, representedDocuments);

  const metricsInput = record(input.metrics, "PageIndex metrics");
  const metrics = {
    documentCount: integer(metricsInput.documentCount, "documentCount", 1),
    representedDocumentCount: integer(metricsInput.representedDocumentCount, "representedDocumentCount", 1),
    rootCount: integer(metricsInput.rootCount, "rootCount", 1),
    nodeCount: integer(metricsInput.nodeCount, "nodeCount", 1),
    maxDepth: integer(metricsInput.maxDepth, "maxDepth", 1),
    documentCharacters: integer(metricsInput.documentCharacters, "documentCharacters", 1),
    inputDigest: digest(metricsInput.inputDigest, "inputDigest"),
    treeDigest: digest(metricsInput.treeDigest, "treeDigest"),
    buildDigest: digest(metricsInput.buildDigest, "buildDigest")
  };
  const aggregateRoots = representedDocuments.reduce((total, document) => total + document.rootCount, 0);
  const aggregateNodes = representedDocuments.reduce((total, document) => total + document.nodeCount, 0);
  const aggregateDepth = Math.max(...representedDocuments.map((document) => document.maxDepth));
  if (
    metrics.documentCount !== representedDocuments.length ||
    metrics.representedDocumentCount !== representedDocuments.length ||
    metrics.rootCount !== aggregateRoots ||
    metrics.nodeCount !== nodes.length ||
    metrics.nodeCount !== aggregateNodes ||
    metrics.maxDepth !== aggregateDepth ||
    metrics.treeDigest !== fingerprint(nodes)
  ) {
    invalid("PageIndex metrics do not match the complete tree");
  }
  const expectedBuildDigest = fingerprint({
    version: 1,
    releaseId: release.releaseId,
    publicSnapshotDigest: release.publicSnapshotDigest,
    inputDigest: metrics.inputDigest,
    treeDigest: metrics.treeDigest,
    adapterName: PAGEINDEX_OSS_ADAPTER_NAME,
    adapterVersion: PAGEINDEX_OSS_SOURCE_PIN,
    sourcePin: PAGEINDEX_OSS_SOURCE_PIN,
    sourceDigest: PAGEINDEX_OSS_SOURCE_DIGEST
  });
  if (metrics.buildDigest !== expectedBuildDigest) {
    invalid("PageIndex build digest does not match its release, source, and tree");
  }

  if (!Array.isArray(input.diagnostics) || input.diagnostics.length > MAX_DIAGNOSTICS) {
    invalid("PageIndex diagnostics are invalid");
  }
  const diagnostics = input.diagnostics.map((value) =>
    typeof value === "string" && value.length <= 1_000 ? value : invalid("PageIndex diagnostic is invalid")
  );
  return {
    version: 1,
    release,
    source,
    representedDocuments,
    metrics,
    nodes,
    diagnostics
  };
}

function validateTree(
  nodes: readonly BoardPageIndexTreeNode[],
  documents: BoardPageIndexTreeArtifactV1["representedDocuments"]
): void {
  const documentOrder = new Map(documents.map((document, index) => [document.documentId, index]));
  const nodesById = new Map<string, BoardPageIndexTreeNode>();
  for (const node of nodes) {
    if (nodesById.has(node.externalId) || !documentOrder.has(node.documentId)) {
      invalid("PageIndex node identity or document reference is invalid");
    }
    if (node.preorderEnd < node.preorderStart) {
      invalid("PageIndex node interval is invalid");
    }
    nodesById.set(node.externalId, node);
  }
  if (
    nodes.some((node, index) => {
      if (index === 0) return false;
      const previous = nodes[index - 1]!;
      return (
        documentOrder.get(previous.documentId)! > documentOrder.get(node.documentId)! ||
        (previous.documentId === node.documentId &&
          (previous.preorderStart > node.preorderStart ||
            (previous.preorderStart === node.preorderStart && previous.externalId.localeCompare(node.externalId) >= 0)))
      );
    })
  ) {
    invalid("PageIndex nodes are not in canonical document/preorder order");
  }
  for (const document of documents) {
    const documentNodes = nodes.filter((node) => node.documentId === document.documentId);
    const starts = documentNodes.map((node) => node.preorderStart);
    if (documentNodes.length !== document.nodeCount || starts.some((start, index) => start !== index + 1)) {
      invalid(`PageIndex document ${document.documentId} is incomplete`);
    }
    const roots = documentNodes.filter((node) => node.parentExternalId === undefined);
    if (
      roots.length !== document.rootCount ||
      Math.max(...documentNodes.map((node) => node.depth)) !== document.maxDepth
    ) {
      invalid(`PageIndex document ${document.documentId} metrics are invalid`);
    }
    const active: BoardPageIndexTreeNode[] = [];
    for (const node of documentNodes) {
      while (active.length > 0 && node.preorderStart > active.at(-1)!.preorderEnd) {
        active.pop();
      }
      const parent = active.at(-1);
      if (
        (parent === undefined && (node.parentExternalId !== undefined || node.depth !== 1)) ||
        (parent !== undefined &&
          (node.parentExternalId !== parent.externalId ||
            node.depth !== parent.depth + 1 ||
            node.preorderEnd > parent.preorderEnd))
      ) {
        invalid(`PageIndex document ${document.documentId} parent graph is invalid`);
      }
      const exactEnd = Math.max(
        ...documentNodes
          .filter(
            (candidate) => candidate.preorderStart >= node.preorderStart && candidate.preorderStart <= node.preorderEnd
          )
          .map((candidate) => candidate.preorderStart)
      );
      if (node.preorderEnd !== exactEnd) {
        invalid(`PageIndex document ${document.documentId} interval is not exact`);
      }
      active.push(node);
    }
  }
}

function validateArtifactRef(
  artifact: ContextArtifactRef,
  scope: BoardContextPublicationScope,
  kind: "pageindex-tree" | "context-release"
): void {
  if (
    artifact.contentType !== "application/json" ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 1 ||
    !SHA256.test(artifact.sha256) ||
    !artifact.uri.trim()
  ) {
    invalid("PageIndex artifact reference is invalid");
  }
  if (
    !isContextArtifactKeyInScope(artifact.key, scope) ||
    !artifact.key.startsWith(`${contextArtifactScopePrefix(scope)}/${kind}/`)
  ) {
    invalid("PageIndex artifact reference is outside the release build scope");
  }
}

function artifactIdentity(artifact: ContextArtifactRef): Record<string, unknown> {
  return {
    uri: artifact.uri,
    key: artifact.key,
    contentType: artifact.contentType,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    ...(artifact.objectGeneration ? { objectGeneration: artifact.objectGeneration } : {})
  };
}

function documentPath(value: unknown): string {
  const path = text(value, "documentPath", 1_024);
  if (
    !path.endsWith(".md") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    invalid("PageIndex represented document path is invalid");
  }
  return path;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function optionalText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function invalid(message: string): never {
  throw new BoardPageIndexAttachmentError("invalid_pageindex_attachment", message);
}

function bounded(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
