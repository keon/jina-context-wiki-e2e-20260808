import { fingerprint, isFullCommitSha, normalizeIsoTime, normalizeRepository, stableId } from "./fingerprint.js";

export const evidenceSourceTypes = ["observation", "blob", "commit", "pull_request", "issue", "document"] as const;

export type EvidenceSourceType = (typeof evidenceSourceTypes)[number];

export type EvidenceAuthorityClass = "source_code" | "provider_state" | "human_document" | "deterministic_analysis";

export interface EvidenceAnchor {
  tenantId: string;
  repository: string;
  sourceType: EvidenceSourceType;
  sourceId: string;
  contentDigest: string;
  commitSha?: string;
  pathOrUrl?: string;
  startLine?: number;
  endLine?: number;
  jsonPointer?: string;
  observedAt?: string;
}

export interface EvidenceRecord {
  id: string;
  anchor: EvidenceAnchor;
  ref: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  authorityClass: EvidenceAuthorityClass;
  aclFingerprint: string;
  createdAt: string;
}

export interface RefManifestEntry {
  tenantId: string;
  repository: string;
  ref: string;
  commitSha: string;
  path: string;
  blobSha: string;
  contentDigest: string;
  language?: string;
  executable: boolean;
}

export type StructuralFactKind =
  "defines" | "imports" | "references" | "calls" | "inherits" | "contains" | "changes" | "owns";

export interface StructuralFact {
  id: string;
  tenantId: string;
  repository: string;
  ref: string;
  commitSha: string;
  kind: StructuralFactKind;
  from: string;
  to: string;
  anchors: EvidenceAnchor[];
  derivationName: string;
  derivationVersion: string;
  metadata: Record<string, unknown>;
}

export interface EvidenceCheckpoint {
  id: string;
  tenantId: string;
  repository: string;
  ref: string;
  refSequence: number;
  commitSha: string;
  parserVersion: string;
  sourceCompleteness: "complete" | "partial";
  observationFrontier: string;
  evidenceFingerprint: string;
  manifestFingerprint: string;
  aclFingerprint: string;
  createdAt: string;
}

export interface GitCommitMetadata {
  treeSha: string;
  parentShas: string[];
  author?: string;
  authoredAt?: string;
  committedAt?: string;
  message: string;
}

export interface GitChange {
  kind: "add" | "modify" | "delete" | "rename" | "copy";
  path: string;
  oldPath?: string;
  oldBlobSha?: string;
  newBlobSha?: string;
}

export interface GitSnapshotMetadata {
  commit: GitCommitMetadata;
  changes: GitChange[];
  history?: (GitCommitMetadata & { sha: string })[];
}

export interface EvidenceSnapshot {
  checkpoint: EvidenceCheckpoint;
  records: EvidenceRecord[];
  manifest: RefManifestEntry[];
  structuralFacts: StructuralFact[];
  git?: GitSnapshotMetadata;
}

export function validateEvidenceAnchor(anchor: EvidenceAnchor): EvidenceAnchor {
  if (anchor.tenantId.trim() === "") throw new Error("Evidence tenantId is required");
  normalizeRepository(anchor.repository);
  if (!evidenceSourceTypes.includes(anchor.sourceType)) throw new Error("Unsupported evidence sourceType");
  if (anchor.sourceId.trim() === "") throw new Error("Evidence sourceId is required");
  if (!/^[0-9a-f]{64}$/i.test(anchor.contentDigest)) throw new Error("Evidence contentDigest must be SHA-256");
  if (anchor.commitSha !== undefined && !isFullCommitSha(anchor.commitSha)) {
    throw new Error("Evidence commitSha must be a full Git SHA");
  }
  if ((anchor.startLine !== undefined || anchor.endLine !== undefined) && anchor.pathOrUrl === undefined) {
    throw new Error("Line ranges require pathOrUrl");
  }
  if (anchor.startLine !== undefined && (!Number.isInteger(anchor.startLine) || anchor.startLine < 1)) {
    throw new Error("startLine must be a positive integer");
  }
  if (anchor.endLine !== undefined && (!Number.isInteger(anchor.endLine) || anchor.endLine < 1)) {
    throw new Error("endLine must be a positive integer");
  }
  if (anchor.startLine !== undefined && anchor.endLine !== undefined && anchor.endLine < anchor.startLine) {
    throw new Error("endLine must not precede startLine");
  }
  if (anchor.observedAt !== undefined) normalizeIsoTime(anchor.observedAt);
  return { ...anchor, repository: normalizeRepository(anchor.repository) };
}

export function createEvidenceRecord(
  input: Omit<EvidenceRecord, "id" | "anchor" | "createdAt"> & {
    anchor: EvidenceAnchor;
    createdAt: string;
    id?: string;
  }
): EvidenceRecord {
  const anchor = validateEvidenceAnchor(input.anchor);
  if (fingerprint(input.body) !== anchor.contentDigest) {
    throw new Error("Evidence body does not match contentDigest");
  }
  if (input.aclFingerprint.trim() === "") throw new Error("Evidence ACL fingerprint is required");
  return {
    ...input,
    id: input.id ?? stableId("ev", anchor),
    anchor,
    createdAt: normalizeIsoTime(input.createdAt)
  };
}

export function validateEvidenceRecord(record: EvidenceRecord): void {
  createEvidenceRecord(record);
  const lines = record.body.split(/\r?\n/).length;
  if (record.anchor.endLine !== undefined && record.anchor.endLine > lines) {
    throw new Error("Evidence line range exceeds source content");
  }
}

/**
 * Resolves an exact excerpt from an immutable evidence body. Ranges and JSON
 * pointers select content from the base record; they are not stored identities.
 */
export function evidenceExcerpt(
  record: EvidenceRecord,
  selector: Pick<EvidenceAnchor, "startLine" | "endLine" | "jsonPointer">
): string | undefined {
  const hasStart = selector.startLine !== undefined;
  const hasEnd = selector.endLine !== undefined;
  if (selector.jsonPointer !== undefined && (hasStart || hasEnd)) return undefined;
  if (hasStart !== hasEnd) return undefined;
  if (hasStart && hasEnd) {
    const lines = record.body.split(/\r?\n/);
    if (
      !Number.isInteger(selector.startLine) ||
      !Number.isInteger(selector.endLine) ||
      selector.startLine! < 1 ||
      selector.endLine! < selector.startLine! ||
      selector.endLine! > lines.length
    ) {
      return undefined;
    }
    return lines.slice(selector.startLine! - 1, selector.endLine).join("\n");
  }
  if (selector.jsonPointer !== undefined) {
    const selected = resolveJsonPointer(record.body, selector.jsonPointer);
    if (!selected.found) return undefined;
    return typeof selected.value === "string" ? selected.value : JSON.stringify(selected.value);
  }
  return record.body;
}

function resolveJsonPointer(body: string, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") {
    try {
      return { found: true, value: JSON.parse(body) as unknown };
    } catch {
      return { found: false };
    }
  }
  if (!pointer.startsWith("/")) return { found: false };
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return { found: false };
  }
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) return { found: false };
      value = value[Number(key)];
    } else if (value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)) {
      value = (value as Record<string, unknown>)[key];
    } else {
      return { found: false };
    }
  }
  return { found: true, value };
}
