export interface WikiTriggerUsageV1 {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
}

export interface WikiTriggerCompletedOutputV1 {
  readonly schemaVersion: 1;
  readonly status: "completed";
  readonly boardBuildId: string;
  readonly triggerParentRunId: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly locale: string;
  readonly releaseFamilyId: string;
  readonly releaseId: string;
  readonly generationId: string;
  readonly releaseArtifactSha256: string;
  readonly contentBundleArtifactSha256: string;
  readonly publicSnapshotDigest: string;
  readonly pageindexAttachmentId: string;
  readonly activationOperationDigest: string;
  readonly usage: WikiTriggerUsageV1;
  readonly completedAt: string;
}

const RESULT_KEYS = [
  "schemaVersion",
  "status",
  "boardBuildId",
  "triggerParentRunId",
  "requestDigest",
  "tenantId",
  "repository",
  "commitSha",
  "locale",
  "releaseFamilyId",
  "releaseId",
  "generationId",
  "releaseArtifactSha256",
  "contentBundleArtifactSha256",
  "publicSnapshotDigest",
  "pageindexAttachmentId",
  "activationOperationDigest",
  "usage",
  "completedAt"
] as const;
const USAGE_KEYS = ["inputTokens", "outputTokens", "costMicros"] as const;
const SHA256 = /^[0-9a-f]{64}$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAX_RESULT_BYTES = 16 * 1024;

export function parseWikiTriggerCompletedOutput(value: unknown): WikiTriggerCompletedOutputV1 {
  const raw = record(value, "wiki trigger completed output");
  assertExactKeys(raw, RESULT_KEYS, "wiki trigger completed output");
  const serialized = JSON.stringify(raw);
  if (utf8ByteLength(serialized) > MAX_RESULT_BYTES) {
    throw new Error(`wiki trigger completed output exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  if (raw.schemaVersion !== 1) throw new Error("wiki trigger completed output schemaVersion must be 1");
  if (raw.status !== "completed") throw new Error("wiki trigger completed output status must be completed");

  const boardBuildId = identifier(raw.boardBuildId, "boardBuildId", 240);
  if (!/^task_[A-Za-z0-9._:-]+$/.test(boardBuildId)) throw new Error("boardBuildId must be a task identifier");
  const repository = boundedString(raw.repository, "repository", 512);
  if (repository !== repository.toLowerCase() || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must be normalized");
  }
  const locale = canonicalLocale(raw.locale, "locale");
  if (locale !== raw.locale) throw new Error("locale must be canonical");
  const releaseId = identifier(raw.releaseId, "releaseId", 240);
  const generationId = identifier(raw.generationId, "generationId", 240);
  if (generationId !== releaseId) throw new Error("generationId must equal releaseId");

  const usage = record(raw.usage, "usage");
  assertExactKeys(usage, USAGE_KEYS, "usage");
  return {
    schemaVersion: 1,
    status: "completed",
    boardBuildId,
    triggerParentRunId: identifier(raw.triggerParentRunId, "triggerParentRunId", 240),
    requestDigest: digest(raw.requestDigest, "requestDigest"),
    tenantId: pathIdentifier(raw.tenantId, "tenantId"),
    repository,
    commitSha: fullCommitSha(raw.commitSha, "commitSha"),
    locale,
    releaseFamilyId: identifier(raw.releaseFamilyId, "releaseFamilyId", 240),
    releaseId,
    generationId,
    releaseArtifactSha256: digest(raw.releaseArtifactSha256, "releaseArtifactSha256"),
    contentBundleArtifactSha256: digest(raw.contentBundleArtifactSha256, "contentBundleArtifactSha256"),
    publicSnapshotDigest: digest(raw.publicSnapshotDigest, "publicSnapshotDigest"),
    pageindexAttachmentId: identifier(raw.pageindexAttachmentId, "pageindexAttachmentId", 240),
    activationOperationDigest: digest(raw.activationOperationDigest, "activationOperationDigest"),
    usage: {
      inputTokens: nonnegativeInteger(usage.inputTokens, "usage.inputTokens"),
      outputTokens: nonnegativeInteger(usage.outputTokens, "usage.outputTokens"),
      costMicros: nonnegativeInteger(usage.costMicros, "usage.costMicros")
    },
    completedAt: isoTimestamp(raw.completedAt, "completedAt")
  };
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (!value || value !== value.trim() || utf8ByteLength(value) > maximumBytes) {
    throw new Error(`${label} must contain between 1 and ${maximumBytes} canonical bytes`);
  }
  return value;
}

function identifier(value: unknown, label: string, maximumBytes: number): string {
  const normalized = boundedString(value, label, maximumBytes);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]*$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function pathIdentifier(value: unknown, label: string): string {
  const normalized = identifier(value, label, 240);
  if (normalized.includes("/")) throw new Error(`${label} cannot contain a path separator`);
  return normalized;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function fullCommitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_COMMIT_SHA.test(value))
    throw new Error(`${label} must be a lowercase full Git SHA`);
  return value;
}

function canonicalLocale(value: unknown, label: string): string {
  const raw = boundedString(value, label, 120);
  try {
    const locales = Intl.getCanonicalLocales(raw);
    if (locales.length !== 1) throw new Error();
    return locales[0]!.toLowerCase();
  } catch {
    throw new Error(`${label} must be a valid BCP-47 locale`);
  }
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a nonnegative integer`);
  return Number(value);
}

function isoTimestamp(value: unknown, label: string): string {
  const raw = boundedString(value, label, 40);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== raw) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return raw;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
