import {
  artifactBytes,
  artifactSha256,
  canonicalJson,
  contextArtifactKey,
  isCanonicalContextArtifactKey,
  normalizeRepository,
  parseWikiContentBundle,
  serializeWikiContentBundle,
  validateWikiAuditReportArtifactRef,
  validateWikiAuditReportBytes,
  validateWikiContentArtifactRef,
  wikiAuditArtifactKey,
  wikiContentArtifactKey,
  wikiContentBundleSha256,
  type ContextArtifactLookup,
  type ContextArtifactRef,
  type ContextArtifactStore,
  type ContextArtifactWrite,
  type WikiAuditArtifactStorePort,
  type WikiAuditReportArtifactRef,
  type WikiAuditReportWrite,
  type WikiContentArtifactRef,
  type WikiContentBundleV1,
  type WikiContentStorePort
} from "@jina/context-engine";
import type { PoolClient, QueryResultRow } from "pg";
import { ContextDatabase } from "./database.js";

export const POSTGRES_CONTEXT_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
export const POSTGRES_WIKI_AUDIT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const POSTGRES_WIKI_CONTENT_MAX_BYTES = 512 * 1024 * 1024;

type ArtifactClass = "context-artifact" | "wiki-content" | "wiki-audit-report";

interface ArtifactRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly repository: string;
  readonly object_key: string;
  readonly object_generation: string | number;
  readonly artifact_class: ArtifactClass;
  readonly content_type: string;
  readonly content_sha256: string;
  readonly content_length: number;
  readonly content_metadata: unknown;
  readonly content_bytes?: Buffer;
  readonly content_equal?: boolean;
}

interface ImmutableWrite {
  readonly tenantId: string;
  readonly repository: string;
  readonly key: string;
  readonly artifactClass: ArtifactClass;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly maximumBytes: number;
}

const ARTIFACT_COLUMNS = `tenant_id,repository,object_key,object_generation,artifact_class,
  content_type,content_sha256,content_length,content_metadata`;

/** PostgreSQL create-only adapter for every immutable wiki pipeline object. */
export class PostgresWikiArtifactStore
  implements ContextArtifactStore, WikiContentStorePort, WikiAuditArtifactStorePort
{
  constructor(private readonly database: ContextDatabase) {}

  async put(input: ContextArtifactWrite): Promise<ContextArtifactRef> {
    const tenantId = exactRequiredText(input.tenantId, "tenantId", 240);
    const repository = exactRequiredText(input.repository, "repository", 512);
    const contentType = exactRequiredText(input.contentType, "contentType", 255);
    const key = contextArtifactKey(input);
    assertKeyTenant(key, tenantId, true);
    const content = artifactBytes(input.content);
    const sha256 = artifactSha256(content);
    const row = await this.writeImmutable({
      tenantId,
      repository,
      key,
      artifactClass: "context-artifact",
      contentType,
      content,
      maximumBytes: POSTGRES_CONTEXT_ARTIFACT_MAX_BYTES,
      metadata: {
        version: 1,
        artifactClass: "context-artifact",
        tenantId,
        repository,
        buildId: exactRequiredText(input.buildId, "buildId", 1_024),
        kind: input.kind,
        name: exactRequiredText(input.name, "name", 1_024),
        contentType,
        bytes: content.byteLength,
        sha256
      }
    });
    return baseRef(row);
  }

  async putIfAbsent(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly bundle: WikiContentBundleV1;
  }): Promise<WikiContentArtifactRef>;
  async putIfAbsent(input: WikiAuditReportWrite): Promise<WikiAuditReportArtifactRef>;
  async putIfAbsent(
    input:
      | { readonly tenantId: string; readonly repository: string; readonly bundle: WikiContentBundleV1 }
      | WikiAuditReportWrite
  ): Promise<WikiContentArtifactRef | WikiAuditReportArtifactRef> {
    return "bundle" in input ? this.putContent(input) : this.putAudit(input);
  }

  async find(input: ContextArtifactLookup): Promise<ContextArtifactRef | undefined>;
  async find(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly bundleSha256: string;
    readonly publicSnapshotDigest: string;
  }): Promise<WikiContentArtifactRef | undefined>;
  async find(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly auditId: string;
    readonly releaseId: string;
    readonly auditInputDigest: string;
  }): Promise<WikiAuditReportArtifactRef | undefined>;
  async find(
    input:
      | ContextArtifactLookup
      | {
          readonly tenantId: string;
          readonly repository: string;
          readonly bundleSha256: string;
          readonly publicSnapshotDigest: string;
        }
      | {
          readonly tenantId: string;
          readonly repository: string;
          readonly auditId: string;
          readonly releaseId: string;
          readonly auditInputDigest: string;
        }
  ): Promise<ContextArtifactRef | WikiContentArtifactRef | WikiAuditReportArtifactRef | undefined> {
    if ("auditId" in input) return this.findAudit(input);
    if ("bundleSha256" in input) return this.findContent(input);
    return this.findContext(input);
  }

  async get(ref: WikiContentArtifactRef): Promise<WikiContentBundleV1>;
  async get(ref: WikiAuditReportArtifactRef): Promise<Uint8Array>;
  async get(ref: ContextArtifactRef): Promise<Uint8Array>;
  async get(ref: ContextArtifactRef | WikiContentArtifactRef | WikiAuditReportArtifactRef) {
    if ("bundleSha256" in ref) {
      const validated = validateWikiContentArtifactRef(ref);
      const content = await this.readExact(validated, "wiki-content");
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(content).toString("utf8"));
      } catch {
        throw new Error("Postgres wiki content artifact must contain JSON");
      }
      const bundle = parseWikiContentBundle(value);
      if (
        wikiContentBundleSha256(bundle) !== validated.bundleSha256 ||
        bundle.publicSnapshotDigest !== validated.publicSnapshotDigest
      ) {
        throw new Error("Postgres wiki content bytes do not match their immutable identity");
      }
      return bundle;
    }
    if ("auditId" in ref) {
      const validated = validateWikiAuditReportArtifactRef(ref);
      const content = await this.readExact(validated, "wiki-audit-report");
      validateWikiAuditReportBytes(content, validated);
      return content;
    }
    if (!isCanonicalContextArtifactKey(ref.key)) {
      throw new Error("Postgres artifact key is not canonical");
    }
    return this.readExact(ref, "context-artifact");
  }

  private async putContent(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly bundle: WikiContentBundleV1;
  }): Promise<WikiContentArtifactRef> {
    const tenantId = exactRequiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const bundle = parseWikiContentBundle(input.bundle);
    const content = Buffer.from(serializeWikiContentBundle(bundle), "utf8");
    const bundleSha256 = artifactSha256(content);
    const key = wikiContentArtifactKey({ tenantId, repository, bundleSha256 });
    assertKeyTenant(key, tenantId);
    const row = await this.writeImmutable({
      tenantId,
      repository,
      key,
      artifactClass: "wiki-content",
      contentType: "application/json",
      content,
      maximumBytes: POSTGRES_WIKI_CONTENT_MAX_BYTES,
      metadata: {
        version: 1,
        artifactClass: "wiki-content",
        tenantId,
        repository,
        publicSnapshotDigest: bundle.publicSnapshotDigest,
        bundleSha256,
        contentType: "application/json",
        bytes: content.byteLength,
        sha256: bundleSha256
      }
    });
    return contentRef(row);
  }

  private async putAudit(input: WikiAuditReportWrite): Promise<WikiAuditReportArtifactRef> {
    const tenantId = exactRequiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const content = artifactBytes(input.content);
    assertObjectSize(content, POSTGRES_WIKI_AUDIT_ARTIFACT_MAX_BYTES, "wiki audit artifact");
    validateWikiAuditReportBytes(content, { ...input, tenantId, repository });
    const sha256 = artifactSha256(content);
    const key = wikiAuditArtifactKey({ tenantId, repository, auditId: input.auditId });
    assertKeyTenant(key, tenantId);
    const row = await this.writeImmutable({
      tenantId,
      repository,
      key,
      artifactClass: "wiki-audit-report",
      contentType: "application/json",
      content,
      maximumBytes: POSTGRES_WIKI_AUDIT_ARTIFACT_MAX_BYTES,
      metadata: {
        version: 1,
        artifactClass: "wiki-audit-report",
        tenantId,
        repository,
        auditId: exactRequiredText(input.auditId, "auditId", 240),
        releaseId: exactRequiredText(input.releaseId, "releaseId", 240),
        auditInputDigest: digest(input.auditInputDigest, "auditInputDigest"),
        contentType: "application/json",
        bytes: content.byteLength,
        sha256
      }
    });
    return auditRef(row);
  }

  private async findContext(input: ContextArtifactLookup): Promise<ContextArtifactRef | undefined> {
    const tenantId = exactRequiredText(input.tenantId, "tenantId", 240);
    const key = contextArtifactKey({ ...input, content: "" });
    assertKeyTenant(key, tenantId, true);
    const row = await this.findRow(tenantId, key);
    if (!row) return undefined;
    assertRowIdentity(row, {
      artifactClass: "context-artifact",
      repository: exactRequiredText(input.repository, "repository", 512),
      contentType: exactRequiredText(input.contentType, "contentType", 255),
      metadata: {
        tenantId,
        repository: input.repository,
        buildId: input.buildId,
        kind: input.kind,
        name: input.name
      }
    });
    return baseRef(row);
  }

  private async findContent(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly bundleSha256: string;
    readonly publicSnapshotDigest: string;
  }): Promise<WikiContentArtifactRef | undefined> {
    const tenantId = exactRequiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const bundleSha256 = digest(input.bundleSha256, "bundleSha256");
    const publicSnapshotDigest = digest(input.publicSnapshotDigest, "publicSnapshotDigest");
    const key = wikiContentArtifactKey({ tenantId, repository, bundleSha256 });
    const row = await this.findRow(tenantId, key);
    if (!row) return undefined;
    assertRowIdentity(row, {
      artifactClass: "wiki-content",
      repository,
      contentType: "application/json",
      metadata: { tenantId, repository, bundleSha256, publicSnapshotDigest }
    });
    return contentRef(row);
  }

  private async findAudit(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly auditId: string;
    readonly releaseId: string;
    readonly auditInputDigest: string;
  }): Promise<WikiAuditReportArtifactRef | undefined> {
    const tenantId = exactRequiredText(input.tenantId, "tenantId", 240);
    const repository = normalizeRepository(input.repository);
    const key = wikiAuditArtifactKey({ tenantId, repository, auditId: input.auditId });
    const row = await this.findRow(tenantId, key);
    if (!row) return undefined;
    assertRowIdentity(row, {
      artifactClass: "wiki-audit-report",
      repository,
      contentType: "application/json",
      metadata: {
        tenantId,
        repository,
        auditId: input.auditId,
        releaseId: input.releaseId,
        auditInputDigest: input.auditInputDigest
      }
    });
    return auditRef(row);
  }

  private async writeImmutable(input: ImmutableWrite): Promise<ArtifactRow> {
    assertObjectSize(input.content, input.maximumBytes, input.artifactClass);
    const sha256 = artifactSha256(input.content);
    const metadata = { ...input.metadata };
    if (Buffer.byteLength(canonicalJson(metadata), "utf8") > 16_384) {
      throw new Error("Postgres wiki artifact metadata is too large");
    }
    const contentBytes = pgBytes(input.content);
    return this.database.transactionAs(
      "jina_context_admin",
      { tenantIds: [input.tenantId] },
      async (client) => {
        const inserted = await client.query<ArtifactRow>(
          `insert into jina_context.context_wiki_artifacts
             (tenant_id,repository,object_key,artifact_class,content_type,content_sha256,
              content_length,content_metadata,content_bytes)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::bytea)
           on conflict (tenant_id,object_key) do nothing
           returning ${ARTIFACT_COLUMNS}`,
          [
            input.tenantId,
            input.repository,
            input.key,
            input.artifactClass,
            input.contentType,
            sha256,
            input.content.byteLength,
            JSON.stringify(metadata),
            contentBytes
          ]
        );
        const row =
          inserted.rows[0] ?? (await this.collisionRow(client, input.tenantId, input.key, contentBytes)).rows[0];
        if (!row) throw new Error(`Postgres wiki artifact disappeared after conflict for ${input.key}`);
        assertImmutableWrite(row, { ...input, metadata }, sha256);
        return row;
      },
      "wiki_artifact_put"
    );
  }

  private collisionRow(client: PoolClient, tenantId: string, key: string, content: Buffer) {
    return client.query<ArtifactRow>(
      `select ${ARTIFACT_COLUMNS},content_bytes=$3::bytea as content_equal
       from jina_context.context_wiki_artifacts
       where tenant_id=$1 and object_key=$2 for share`,
      [tenantId, key, content]
    );
  }

  private async findRow(tenantId: string, key: string): Promise<ArtifactRow | undefined> {
    const result = await this.database.queryAs<ArtifactRow>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select ${ARTIFACT_COLUMNS}
       from jina_context.context_wiki_artifacts
       where tenant_id=$1 and object_key=$2`,
      [tenantId, key],
      "wiki_artifact_find"
    );
    return result.rows[0];
  }

  private async readExact(ref: ContextArtifactRef, expectedClass: ArtifactClass): Promise<Uint8Array> {
    const generation = positiveGeneration(ref.objectGeneration);
    const tenantId = assertKeyTenant(ref.key, undefined, expectedClass === "context-artifact");
    if (ref.uri !== artifactUri(ref.key, generation)) {
      throw new Error("Postgres wiki artifact URI does not match its key and generation");
    }
    const contentType = exactRequiredText(ref.contentType, "artifact contentType", 255);
    const sha256 = digest(ref.sha256, "artifact sha256");
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > POSTGRES_WIKI_CONTENT_MAX_BYTES) {
      throw new Error("Postgres wiki artifact byte count is invalid");
    }
    const result = await this.database.queryAs<ArtifactRow>(
      "jina_context_admin",
      { tenantIds: [tenantId] },
      `select ${ARTIFACT_COLUMNS},content_bytes
       from jina_context.context_wiki_artifacts
       where tenant_id=$1 and object_key=$2 and object_generation=$3::bigint`,
      [tenantId, ref.key, generation],
      "wiki_artifact_get"
    );
    const row = result.rows[0];
    if (!row) throw new Error("Postgres wiki artifact immutable reference was not found");
    if (
      row.artifact_class !== expectedClass ||
      row.content_type !== contentType ||
      row.content_sha256 !== sha256 ||
      row.content_length !== ref.bytes ||
      positiveGeneration(row.object_generation) !== generation ||
      !row.content_bytes
    ) {
      throw new Error("Postgres wiki artifact metadata does not match its immutable reference");
    }
    const content = row.content_bytes;
    if (content.byteLength !== ref.bytes || artifactSha256(content) !== sha256) {
      throw new Error("Postgres wiki artifact bytes do not match their immutable reference");
    }
    return content;
  }
}

function assertImmutableWrite(row: ArtifactRow, input: ImmutableWrite, sha256: string): void {
  const sameMetadata = canonicalJson(row.content_metadata) === canonicalJson(input.metadata);
  if (
    row.tenant_id !== input.tenantId ||
    row.repository !== input.repository ||
    row.object_key !== input.key ||
    row.artifact_class !== input.artifactClass ||
    row.content_type !== input.contentType ||
    row.content_sha256 !== sha256 ||
    row.content_length !== input.content.byteLength ||
    !sameMetadata ||
    (row.content_equal !== undefined && row.content_equal !== true)
  ) {
    throw new Error(`Postgres wiki artifact key collision for ${input.key}`);
  }
  positiveGeneration(row.object_generation);
}

function assertRowIdentity(
  row: ArtifactRow,
  expected: {
    readonly artifactClass: ArtifactClass;
    readonly repository: string;
    readonly contentType: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }
): void {
  const metadata = objectValue(row.content_metadata, "Postgres wiki artifact metadata");
  if (
    row.artifact_class !== expected.artifactClass ||
    row.repository !== expected.repository ||
    row.content_type !== expected.contentType ||
    Object.entries(expected.metadata).some(([key, value]) => metadata[key] !== value)
  ) {
    throw new Error(`Postgres wiki artifact lookup metadata mismatch for ${row.object_key}`);
  }
}

function baseRef(row: ArtifactRow): ContextArtifactRef {
  const generation = positiveGeneration(row.object_generation);
  return {
    uri: artifactUri(row.object_key, generation),
    key: row.object_key,
    contentType: row.content_type,
    bytes: row.content_length,
    sha256: row.content_sha256,
    objectGeneration: generation
  };
}

function contentRef(row: ArtifactRow): WikiContentArtifactRef {
  const metadata = objectValue(row.content_metadata, "Postgres wiki content metadata");
  return validateWikiContentArtifactRef(
    {
      version: 1,
      tenantId: row.tenant_id,
      repository: row.repository,
      publicSnapshotDigest: metadata.publicSnapshotDigest,
      bundleSha256: metadata.bundleSha256,
      ...baseRef(row)
    },
    { tenantId: row.tenant_id, repository: row.repository }
  );
}

function auditRef(row: ArtifactRow): WikiAuditReportArtifactRef {
  const metadata = objectValue(row.content_metadata, "Postgres wiki audit metadata");
  return validateWikiAuditReportArtifactRef({
    version: 1,
    tenantId: row.tenant_id,
    repository: row.repository,
    auditId: metadata.auditId,
    releaseId: metadata.releaseId,
    auditInputDigest: metadata.auditInputDigest,
    ...baseRef(row)
  });
}

function artifactUri(key: string, generation: string): string {
  return `postgres://jina_context/context_wiki_artifacts/${key}?generation=${generation}`;
}

function assertKeyTenant(key: string, expected?: string, requireBuildKey = false): string {
  if (requireBuildKey && !isCanonicalContextArtifactKey(key)) {
    throw new Error("Postgres artifact key is not canonical");
  }
  const segments = key.split("/");
  if (segments[0] !== "context" || segments[1] !== "tenants" || !segments[2]) {
    throw new Error("Postgres wiki artifact key is not tenant scoped");
  }
  let tenantId: string;
  try {
    tenantId = decodeURIComponent(segments[2]);
  } catch {
    throw new Error("Postgres wiki artifact tenant segment is invalid");
  }
  if (encodeURIComponent(tenantId) !== segments[2] || !tenantId.trim() || tenantId !== tenantId.trim()) {
    throw new Error("Postgres wiki artifact tenant segment is not canonical");
  }
  if (expected !== undefined && tenantId !== expected) {
    throw new Error("Postgres wiki artifact key escapes its tenant scope");
  }
  return tenantId;
}

function positiveGeneration(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Postgres wiki artifact generation is invalid");
  }
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Postgres wiki artifact generation is invalid");
  }
  const generation = typeof value === "number" ? String(value) : value;
  if (!/^[1-9][0-9]*$/.test(generation)) throw new Error("Postgres wiki artifact generation is invalid");
  return generation;
}

function assertObjectSize(content: Uint8Array, maximum: number, label: string): void {
  if (content.byteLength > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
}

function pgBytes(content: Uint8Array): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

function exactRequiredText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}
