import { normalizeWikiRefIdentity, wikiSourceScopeKinds, type WikiSourceScopeKind } from "./wiki-ref.js";

export const CONTEXT_WIKI_TRIGGER_QUEUE_NAME = "context-wiki";

export const wikiGenerationReasons = [
  "initial",
  "source_update",
  "daily_audit_fix",
  "manual_refresh",
  "translation"
] as const;

export type WikiGenerationReason = (typeof wikiGenerationReasons)[number];

export interface ImmutableArtifactRefV1 {
  readonly uri: string;
  readonly key: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly objectGeneration: string;
}

export interface WikiTriggerSourceV1 {
  readonly commitSha: string;
  readonly ref: string;
  readonly scopeKind: WikiSourceScopeKind;
  readonly scopeKey: string;
  readonly refSequence?: number;
  readonly baseCommitSha?: string;
  readonly githubInstallationId?: number;
}

export interface WikiTriggerImprovementV1 {
  readonly auditId: string;
  readonly auditedReleaseId: string;
  readonly auditInputDigest: string;
  readonly findingsArtifact: ImmutableArtifactRefV1;
  readonly findingsDigest: string;
}

export interface WikiTriggerOptionsV1 {
  readonly idempotencyKey: string;
  readonly concurrencyKey: string;
  readonly queue: string;
  readonly tags: readonly string[];
}

export interface WikiTriggerRequestV1 {
  readonly schemaVersion: 1;
  readonly taskIdentifier: "generate-wiki";
  readonly boardBuildId: string;
  readonly tenantId: string;
  readonly repository: string;
  readonly source: WikiTriggerSourceV1;
  readonly requestKey: string;
  readonly generationReason: WikiGenerationReason;
  readonly releaseFamilyId: string;
  readonly parentReleaseId?: string;
  readonly sourceReleaseId?: string;
  readonly sourceLocale?: string;
  readonly improvement?: WikiTriggerImprovementV1;
  readonly requestedLocale: string;
  readonly pipelineVersion: "context_wiki.trigger.v1";
  readonly generatorPolicyVersion: string;
  readonly options: WikiTriggerOptionsV1;
}

/** Canonical repository-scoped key used by the durable audit store and Trigger contracts. */
export function contextWikiAuditReportArtifactKey(input: {
  readonly tenantId: string;
  readonly repository: string;
  readonly auditId: string;
}): string {
  const [owner, name] = input.repository.split("/") as [string, string];
  return `context/tenants/${encodeURIComponent(input.tenantId)}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/audits/${encodeURIComponent(input.auditId)}/wiki-audit-report/report.json`;
}

const REQUEST_KEYS = [
  "schemaVersion",
  "taskIdentifier",
  "boardBuildId",
  "tenantId",
  "repository",
  "source",
  "requestKey",
  "generationReason",
  "releaseFamilyId",
  "parentReleaseId",
  "sourceReleaseId",
  "sourceLocale",
  "improvement",
  "requestedLocale",
  "pipelineVersion",
  "generatorPolicyVersion",
  "options"
] as const;
const SOURCE_KEYS = [
  "commitSha",
  "ref",
  "scopeKind",
  "scopeKey",
  "refSequence",
  "baseCommitSha",
  "githubInstallationId"
] as const;
const IMPROVEMENT_KEYS = [
  "auditId",
  "auditedReleaseId",
  "auditInputDigest",
  "findingsArtifact",
  "findingsDigest"
] as const;
const ARTIFACT_KEYS = ["uri", "key", "contentType", "bytes", "sha256", "objectGeneration"] as const;
const OPTIONS_KEYS = ["idempotencyKey", "concurrencyKey", "queue", "tags"] as const;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_REQUEST_BYTES = 24 * 1024;

/** Strictly validates and returns the normalized request used for hashing and dispatch. */
export function parseWikiTriggerRequest(value: unknown): WikiTriggerRequestV1 {
  const raw = record(value, "wiki trigger request");
  assertExactKeys(
    raw,
    REQUEST_KEYS,
    [
      "schemaVersion",
      "taskIdentifier",
      "boardBuildId",
      "tenantId",
      "repository",
      "source",
      "requestKey",
      "generationReason",
      "releaseFamilyId",
      "requestedLocale",
      "pipelineVersion",
      "generatorPolicyVersion",
      "options"
    ],
    "wiki trigger request"
  );
  assertMaximumJsonBytes(raw, MAX_REQUEST_BYTES, "wiki trigger request");

  if (raw.schemaVersion !== 1) throw new Error("wiki trigger request schemaVersion must be 1");
  if (raw.taskIdentifier !== "generate-wiki") {
    throw new Error("wiki trigger request taskIdentifier must be generate-wiki");
  }
  if (raw.pipelineVersion !== "context_wiki.trigger.v1") {
    throw new Error("wiki trigger request pipelineVersion is unsupported");
  }

  const boardBuildId = identifier(raw.boardBuildId, "boardBuildId", 240);
  if (!/^task_[A-Za-z0-9._:-]+$/.test(boardBuildId)) {
    throw new Error("boardBuildId must be a task identifier");
  }
  const tenantId = pathIdentifier(raw.tenantId, "tenantId");
  const repository = normalizedRepository(raw.repository);
  const source = parseSource(raw.source);
  const requestKey = boundedString(raw.requestKey, "requestKey", 512);
  const generationReason = oneOf(raw.generationReason, wikiGenerationReasons, "generationReason");
  const releaseFamilyId = identifier(raw.releaseFamilyId, "releaseFamilyId", 240);
  const parentReleaseId = optionalIdentifier(raw.parentReleaseId, "parentReleaseId", 240);
  const requestedLocale = canonicalLocale(raw.requestedLocale, "requestedLocale");
  const sourceReleaseId = optionalIdentifier(raw.sourceReleaseId, "sourceReleaseId", 240);
  const sourceLocale = optionalLocale(raw.sourceLocale, "sourceLocale");

  if (generationReason === "translation") {
    if (!sourceReleaseId || !sourceLocale) {
      throw new Error("translation requires sourceReleaseId and sourceLocale");
    }
    if (sourceLocale === requestedLocale) throw new Error("translation sourceLocale must differ from requestedLocale");
  } else if (sourceReleaseId !== undefined || sourceLocale !== undefined) {
    throw new Error("sourceReleaseId and sourceLocale are only valid for translation");
  }
  if (generationReason === "initial" && parentReleaseId !== undefined) {
    throw new Error("initial generation cannot have a parentReleaseId");
  }

  const improvement =
    raw.improvement === undefined ? undefined : parseImprovement(raw.improvement, tenantId, repository);
  if (generationReason === "daily_audit_fix" && !improvement) {
    throw new Error("daily_audit_fix requires improvement evidence");
  }
  if (generationReason !== "daily_audit_fix" && improvement) {
    throw new Error("improvement is only valid for daily_audit_fix");
  }

  const options = parseOptions(raw.options);
  const result: WikiTriggerRequestV1 = {
    schemaVersion: 1,
    taskIdentifier: "generate-wiki",
    boardBuildId,
    tenantId,
    repository,
    source,
    requestKey,
    generationReason,
    releaseFamilyId,
    ...(parentReleaseId ? { parentReleaseId } : {}),
    ...(sourceReleaseId ? { sourceReleaseId } : {}),
    ...(sourceLocale ? { sourceLocale } : {}),
    ...(improvement ? { improvement } : {}),
    requestedLocale,
    pipelineVersion: "context_wiki.trigger.v1",
    generatorPolicyVersion: identifier(raw.generatorPolicyVersion, "generatorPolicyVersion", 240),
    options
  };
  assertMaximumJsonBytes(result, MAX_REQUEST_BYTES, "canonical wiki trigger request");
  return result;
}

/** Canonical JSON has recursively sorted object keys and preserves array order. */
export function canonicalWikiTriggerRequestJson(value: unknown): string {
  return canonicalJsonValue(parseWikiTriggerRequest(value));
}

export function wikiTriggerRequestDigest(value: unknown): string {
  return sha256(canonicalWikiTriggerRequestJson(value));
}

function parseSource(value: unknown): WikiTriggerSourceV1 {
  const raw = record(value, "source");
  assertExactKeys(raw, SOURCE_KEYS, ["commitSha", "ref", "scopeKind", "scopeKey"], "source");
  const commitSha = fullCommitSha(raw.commitSha, "source.commitSha");
  const scopeKind = oneOf(raw.scopeKind, wikiSourceScopeKinds, "source.scopeKind");
  const suppliedScopeKey = boundedString(raw.scopeKey, "source.scopeKey", 512);
  const identity = normalizeWikiRefIdentity({ scopeKind, scopeKey: suppliedScopeKey });
  if (identity.scopeKey !== suppliedScopeKey) throw new Error("source.scopeKey must be canonical");
  if (raw.ref !== identity.ref) throw new Error(`source.ref must be ${identity.ref}`);
  if (scopeKind === "commit" && identity.scopeKey !== commitSha) {
    throw new Error("commit scopeKey must equal source.commitSha");
  }

  const refSequence = optionalPositiveInteger(raw.refSequence, "source.refSequence");
  if (scopeKind === "commit" && refSequence !== undefined) {
    throw new Error("commit source forbids refSequence");
  }
  if (scopeKind !== "commit" && refSequence === undefined) {
    throw new Error("branch and pull request sources require refSequence");
  }
  const baseCommitSha =
    raw.baseCommitSha === undefined ? undefined : fullCommitSha(raw.baseCommitSha, "source.baseCommitSha");
  if (scopeKind === "pull_request" && baseCommitSha === undefined) {
    throw new Error("pull_request source requires baseCommitSha");
  }
  if (baseCommitSha !== undefined && scopeKind !== "pull_request") {
    throw new Error("source.baseCommitSha is only valid for pull_request scope");
  }
  const githubInstallationId = optionalPositiveInteger(raw.githubInstallationId, "source.githubInstallationId");
  return {
    commitSha,
    ref: identity.ref,
    scopeKind,
    scopeKey: identity.scopeKey,
    ...(refSequence !== undefined ? { refSequence } : {}),
    ...(baseCommitSha ? { baseCommitSha } : {}),
    ...(githubInstallationId !== undefined ? { githubInstallationId } : {})
  };
}

function parseImprovement(value: unknown, tenantId: string, repository: string): WikiTriggerImprovementV1 {
  const raw = record(value, "improvement");
  assertExactKeys(raw, IMPROVEMENT_KEYS, IMPROVEMENT_KEYS, "improvement");
  const auditId = identifier(raw.auditId, "improvement.auditId", 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(auditId)) {
    throw new Error("improvement.auditId is invalid");
  }
  const findingsArtifact = parseArtifact(raw.findingsArtifact);
  const expectedKey = contextWikiAuditReportArtifactKey({ tenantId, repository, auditId });
  if (findingsArtifact.key !== expectedKey) {
    throw new Error("improvement.findingsArtifact is outside the audit's repository scope");
  }
  return {
    auditId,
    auditedReleaseId: identifier(raw.auditedReleaseId, "improvement.auditedReleaseId", 240),
    auditInputDigest: digest(raw.auditInputDigest, "improvement.auditInputDigest"),
    findingsArtifact,
    findingsDigest: digest(raw.findingsDigest, "improvement.findingsDigest")
  };
}

function parseArtifact(value: unknown): ImmutableArtifactRefV1 {
  const raw = record(value, "improvement.findingsArtifact");
  assertExactKeys(raw, ARTIFACT_KEYS, ARTIFACT_KEYS, "improvement.findingsArtifact");
  const contentType = boundedString(raw.contentType, "improvement.findingsArtifact.contentType", 120).toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("improvement.findingsArtifact.contentType must be application/json");
  }
  return {
    uri: boundedString(raw.uri, "improvement.findingsArtifact.uri", 2_048),
    key: boundedString(raw.key, "improvement.findingsArtifact.key", 2_048),
    contentType,
    bytes: nonnegativeInteger(raw.bytes, "improvement.findingsArtifact.bytes"),
    sha256: digest(raw.sha256, "improvement.findingsArtifact.sha256"),
    objectGeneration: digits(raw.objectGeneration, "improvement.findingsArtifact.objectGeneration", 40)
  };
}

function parseOptions(value: unknown): WikiTriggerOptionsV1 {
  const raw = record(value, "options");
  assertExactKeys(raw, OPTIONS_KEYS, OPTIONS_KEYS, "options");
  if (!Array.isArray(raw.tags) || raw.tags.length > 16) throw new Error("options.tags must contain at most 16 tags");
  const tags = raw.tags.map((tag, index) => identifier(tag, `options.tags[${index}]`, 120));
  if (new Set(tags).size !== tags.length) throw new Error("options.tags must not contain duplicates");
  const sortedTags = [...tags].sort();
  const queue = identifier(raw.queue, "options.queue", 120);
  if (queue !== CONTEXT_WIKI_TRIGGER_QUEUE_NAME) {
    throw new Error(`options.queue must be ${CONTEXT_WIKI_TRIGGER_QUEUE_NAME}`);
  }
  return {
    idempotencyKey: identifier(raw.idempotencyKey, "options.idempotencyKey", 512),
    concurrencyKey: identifier(raw.concurrencyKey, "options.concurrencyKey", 512),
    queue,
    tags: sortedTags
  };
}

function canonicalJsonValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJsonValue(child)}`);
    return `{${fields.join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("wiki trigger request is not JSON serializable");
  return serialized;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || utf8ByteLength(normalized) > maximumBytes) {
    throw new Error(`${label} must contain between 1 and ${maximumBytes} bytes`);
  }
  return normalized;
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

function optionalIdentifier(value: unknown, label: string, maximumBytes: number): string | undefined {
  return value === undefined ? undefined : identifier(value, label, maximumBytes);
}

function normalizedRepository(value: unknown): string {
  const repository = boundedString(value, "repository", 512).toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new Error("repository is invalid");
  return repository;
}

function fullCommitSha(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a full Git SHA`);
  const normalized = value.toLowerCase();
  if (!FULL_COMMIT_SHA.test(normalized)) throw new Error(`${label} must be a full Git SHA`);
  return normalized;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a nonnegative integer`);
  return Number(value);
}

function digits(value: unknown, label: string, maximumBytes: number): string {
  const normalized = boundedString(value, label, maximumBytes);
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new Error(`${label} must be a positive decimal string`);
  return normalized;
}

function canonicalLocale(value: unknown, label: string): string {
  const raw = boundedString(value, label, 120);
  try {
    const canonical = Intl.getCanonicalLocales(raw);
    if (canonical.length !== 1) throw new Error();
    // Locale is also part of pointer and artifact identity. Preserve BCP-47
    // validation while using one case-insensitive storage spelling everywhere.
    return canonical[0]!.toLowerCase();
  } catch {
    throw new Error(`${label} must be a valid BCP-47 locale`);
  }
}

function optionalLocale(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : canonicalLocale(value, label);
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertMaximumJsonBytes(value: unknown, maximum: number, label: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (utf8ByteLength(serialized) > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// Small synchronous SHA-256 keeps the shared contract browser-safe while the
// Board admission path can still derive a digest without an async crypto API.
function sha256(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2
  ]);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + constants[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }

  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}
