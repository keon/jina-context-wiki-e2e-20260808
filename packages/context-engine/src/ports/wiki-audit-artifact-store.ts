import { normalizeRepository } from "../domain/fingerprint.js";
import { contextWikiAuditReportArtifactKey } from "@jina/shared-kernel";
import { contextArtifactRepositoryPrefix, type ContextArtifactRef } from "./artifact-store.js";

export interface WikiAuditReportArtifactRef extends ContextArtifactRef {
  readonly version: 1;
  readonly tenantId: string;
  readonly repository: string;
  readonly auditId: string;
  readonly releaseId: string;
  readonly auditInputDigest: string;
  readonly contentType: "application/json";
  readonly objectGeneration: string;
}

export interface WikiAuditReportWrite {
  readonly tenantId: string;
  readonly repository: string;
  readonly auditId: string;
  readonly releaseId: string;
  readonly auditInputDigest: string;
  /** Exact canonical report bytes. Identity fields are verified before storage. */
  readonly content: string | Uint8Array;
}

export interface WikiAuditArtifactStorePort {
  putIfAbsent(input: WikiAuditReportWrite): Promise<WikiAuditReportArtifactRef>;
  find(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly auditId: string;
    readonly releaseId: string;
    readonly auditInputDigest: string;
  }): Promise<WikiAuditReportArtifactRef | undefined>;
  get(ref: WikiAuditReportArtifactRef): Promise<Uint8Array>;
}

export function wikiAuditArtifactKey(input: {
  readonly tenantId: string;
  readonly repository: string;
  readonly auditId: string;
}): string {
  const tenantId = requiredText(input.tenantId, "tenantId", 240);
  const repository = normalizeRepository(input.repository);
  const auditId = safeIdentifier(input.auditId, "auditId");
  const key = contextWikiAuditReportArtifactKey({ tenantId, repository, auditId });
  const repositoryPrefix = contextArtifactRepositoryPrefix({ tenantId, repository });
  if (!key.startsWith(`${repositoryPrefix}/audits/`))
    throw new Error("wiki audit artifact key escaped repository scope");
  return key;
}

export function validateWikiAuditReportBytes(
  bytes: Uint8Array,
  expected: {
    readonly tenantId: string;
    readonly repository: string;
    readonly auditId: string;
    readonly releaseId: string;
    readonly auditInputDigest: string;
  }
): void {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("wiki audit report must be JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("wiki audit report must be an object");
  }
  const report = value as Record<string, unknown>;
  if (
    report.version !== 1 ||
    report.tenantId !== expected.tenantId.trim() ||
    report.repository !== normalizeRepository(expected.repository) ||
    report.auditId !== expected.auditId ||
    report.releaseId !== expected.releaseId ||
    report.auditInputDigest !== digest(expected.auditInputDigest, "auditInputDigest")
  ) {
    throw new Error("wiki audit report identity does not match its authorized scope");
  }
}

export function validateWikiAuditReportArtifactRef(
  value: unknown,
  expected?: {
    readonly tenantId: string;
    readonly repository: string;
    readonly auditId: string;
    readonly releaseId: string;
    readonly auditInputDigest: string;
  }
): WikiAuditReportArtifactRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("wiki audit artifact must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new Error("wiki audit artifact version must be 1");
  const tenantId = requiredText(input.tenantId, "tenantId", 240);
  const repository = normalizeRepository(requiredText(input.repository, "repository", 512));
  const auditId = safeIdentifier(input.auditId, "auditId");
  const releaseId = safeIdentifier(input.releaseId, "releaseId");
  const auditInputDigest = digest(input.auditInputDigest, "auditInputDigest");
  const sha256 = digest(input.sha256, "sha256");
  const key = requiredText(input.key, "key", 4_096);
  if (key !== wikiAuditArtifactKey({ tenantId, repository, auditId })) {
    throw new Error("wiki audit artifact key does not match its authorized scope");
  }
  if (input.contentType !== "application/json") throw new Error("wiki audit artifact content type is invalid");
  const objectGeneration = requiredText(input.objectGeneration, "objectGeneration", 240);
  if (!/^[1-9][0-9]*$/.test(objectGeneration)) throw new Error("wiki audit object generation is invalid");
  const bytes = input.bytes;
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 1) throw new Error("wiki audit artifact bytes are invalid");
  const uri = requiredText(input.uri, "uri", 4_096);
  if (
    expected &&
    (tenantId !== expected.tenantId.trim() ||
      repository !== normalizeRepository(expected.repository) ||
      auditId !== expected.auditId ||
      releaseId !== expected.releaseId ||
      auditInputDigest !== expected.auditInputDigest)
  ) {
    throw new Error("wiki audit artifact escapes its authorized audit scope");
  }
  return {
    version: 1,
    tenantId,
    repository,
    auditId,
    releaseId,
    auditInputDigest,
    uri,
    key,
    contentType: "application/json",
    bytes: bytes as number,
    sha256,
    objectGeneration
  };
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  const text = requiredText(value, label, 240);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,239}$/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}
