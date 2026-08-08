import { Storage, type FileMetadata } from "@google-cloud/storage";
import {
  artifactBytes,
  artifactSha256,
  normalizeRepository,
  parseWikiContentBundle,
  serializeWikiContentBundle,
  validateWikiAuditReportArtifactRef,
  validateWikiAuditReportBytes,
  validateWikiContentArtifactRef,
  wikiAuditArtifactKey,
  wikiContentArtifactKey,
  wikiContentBundleSha256,
  type WikiAuditArtifactStorePort,
  type WikiAuditReportArtifactRef,
  type WikiAuditReportWrite,
  type WikiContentArtifactRef,
  type WikiContentBundleV1,
  type WikiContentStorePort
} from "@jina/context-engine";

/** Durable, create-only repository content and audit report objects. */
export class GcsWikiArtifactStore implements WikiContentStorePort, WikiAuditArtifactStorePort {
  readonly #storage: Storage;
  readonly #bucketName: string;

  constructor(
    bucketName: string,
    options: { readonly projectId?: string; readonly keyFilename?: string; readonly storage?: Storage } = {}
  ) {
    if (!bucketName.trim() || bucketName !== bucketName.trim() || /[/?#\\\s\0]/.test(bucketName)) {
      throw new Error("GCS wiki artifact bucket is invalid");
    }
    this.#bucketName = bucketName;
    this.#storage =
      options.storage ??
      new Storage({
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.keyFilename ? { keyFilename: options.keyFilename } : {})
      });
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
  ): Promise<WikiContentArtifactRef | WikiAuditReportArtifactRef | undefined> {
    if ("auditId" in input) return this.findAudit(input);
    const repository = normalizeRepository(input.repository);
    const key = wikiContentArtifactKey(input);
    const file = this.#storage.bucket(this.#bucketName).file(key);
    let metadata: FileMetadata;
    try {
      [metadata] = await file.getMetadata();
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
    if (
      metadata.metadata?.tenantId !== input.tenantId ||
      metadata.metadata?.repository !== repository ||
      metadata.metadata?.kind !== "wiki-content" ||
      metadata.metadata?.publicSnapshotDigest !== input.publicSnapshotDigest ||
      metadata.metadata?.sha256 !== input.bundleSha256
    ) {
      throw new Error(`GCS wiki artifact metadata mismatch for ${key}`);
    }
    return validateWikiContentArtifactRef(
      {
        version: 1,
        tenantId: input.tenantId,
        repository,
        publicSnapshotDigest: input.publicSnapshotDigest,
        bundleSha256: input.bundleSha256,
        uri: this.uri(key),
        key,
        contentType: metadata.contentType,
        bytes: Number(metadata.size),
        sha256: metadata.metadata?.sha256,
        objectGeneration: requiredGeneration(metadata)
      },
      { tenantId: input.tenantId, repository }
    );
  }

  private async findAudit(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly auditId: string;
    readonly releaseId: string;
    readonly auditInputDigest: string;
  }): Promise<WikiAuditReportArtifactRef | undefined> {
    const repository = normalizeRepository(input.repository);
    const key = wikiAuditArtifactKey({ tenantId: input.tenantId, repository, auditId: input.auditId });
    const file = this.#storage.bucket(this.#bucketName).file(key);
    let metadata: FileMetadata;
    try {
      [metadata] = await file.getMetadata();
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      throw error;
    }
    if (
      metadata.metadata?.tenantId !== input.tenantId ||
      metadata.metadata?.repository !== repository ||
      metadata.metadata?.auditId !== input.auditId ||
      metadata.metadata?.releaseId !== input.releaseId ||
      metadata.metadata?.auditInputDigest !== input.auditInputDigest ||
      metadata.metadata?.kind !== "wiki-audit-report"
    ) {
      throw new Error(`GCS wiki audit metadata mismatch for ${key}`);
    }
    return validateWikiAuditReportArtifactRef(
      {
        version: 1,
        tenantId: input.tenantId,
        repository,
        auditId: input.auditId,
        releaseId: input.releaseId,
        auditInputDigest: input.auditInputDigest,
        uri: this.uri(key),
        key,
        contentType: metadata.contentType,
        bytes: Number(metadata.size),
        sha256: metadata.metadata?.sha256,
        objectGeneration: requiredGeneration(metadata)
      },
      input
    );
  }

  async get(ref: WikiContentArtifactRef): Promise<WikiContentBundleV1>;
  async get(ref: WikiAuditReportArtifactRef): Promise<Uint8Array>;
  async get(ref: WikiContentArtifactRef | WikiAuditReportArtifactRef): Promise<WikiContentBundleV1 | Uint8Array> {
    if ("bundleSha256" in ref) {
      const validated = validateWikiContentArtifactRef(ref);
      const bytes = await this.readExact(validated);
      const bundle = parseWikiContentBundle(JSON.parse(Buffer.from(bytes).toString("utf8")));
      if (
        wikiContentBundleSha256(bundle) !== validated.bundleSha256 ||
        bundle.publicSnapshotDigest !== validated.publicSnapshotDigest
      ) {
        throw new Error("GCS wiki content bytes do not match their immutable identity");
      }
      return bundle;
    }
    const validated = validateWikiAuditReportArtifactRef(ref);
    const bytes = await this.readExact(validated);
    validateWikiAuditReportBytes(bytes, validated);
    return bytes;
  }

  private async putContent(input: {
    readonly tenantId: string;
    readonly repository: string;
    readonly bundle: WikiContentBundleV1;
  }): Promise<WikiContentArtifactRef> {
    const repository = normalizeRepository(input.repository);
    const content = Buffer.from(serializeWikiContentBundle(input.bundle), "utf8");
    const bundleSha256 = artifactSha256(content);
    const key = wikiContentArtifactKey({ tenantId: input.tenantId, repository, bundleSha256 });
    const metadata = await this.createOnly(key, content, {
      tenantId: input.tenantId,
      repository,
      kind: "wiki-content",
      publicSnapshotDigest: input.bundle.publicSnapshotDigest,
      sha256: bundleSha256
    });
    return validateWikiContentArtifactRef(
      {
        version: 1,
        tenantId: input.tenantId,
        repository,
        publicSnapshotDigest: input.bundle.publicSnapshotDigest,
        bundleSha256,
        uri: this.uri(key),
        key,
        contentType: "application/json",
        bytes: content.byteLength,
        sha256: bundleSha256,
        objectGeneration: requiredGeneration(metadata)
      },
      { tenantId: input.tenantId, repository }
    );
  }

  private async putAudit(input: WikiAuditReportWrite): Promise<WikiAuditReportArtifactRef> {
    const repository = normalizeRepository(input.repository);
    const content = artifactBytes(input.content);
    validateWikiAuditReportBytes(content, { ...input, repository });
    const sha256 = artifactSha256(content);
    const key = wikiAuditArtifactKey({ tenantId: input.tenantId, repository, auditId: input.auditId });
    const metadata = await this.createOnly(key, content, {
      tenantId: input.tenantId,
      repository,
      auditId: input.auditId,
      releaseId: input.releaseId,
      auditInputDigest: input.auditInputDigest,
      kind: "wiki-audit-report",
      sha256
    });
    return validateWikiAuditReportArtifactRef(
      {
        version: 1,
        tenantId: input.tenantId,
        repository,
        auditId: input.auditId,
        releaseId: input.releaseId,
        auditInputDigest: input.auditInputDigest,
        uri: this.uri(key),
        key,
        contentType: "application/json",
        bytes: content.byteLength,
        sha256,
        objectGeneration: requiredGeneration(metadata)
      },
      input
    );
  }

  private async createOnly(
    key: string,
    content: Uint8Array,
    customMetadata: Readonly<Record<string, string>>
  ): Promise<FileMetadata> {
    const bucket = this.#storage.bucket(this.#bucketName);
    const file = bucket.file(key);
    let collided = false;
    try {
      await file.save(Buffer.from(content), {
        resumable: content.byteLength >= 5 * 1024 * 1024,
        validation: "crc32c",
        metadata: { contentType: "application/json", metadata: { ...customMetadata } },
        preconditionOpts: { ifGenerationMatch: 0 }
      });
    } catch (error) {
      if (statusCode(error) !== 412) throw error;
      collided = true;
    }
    const [metadata] = await file.getMetadata();
    if (
      Number(metadata.size) !== content.byteLength ||
      metadata.contentType !== "application/json" ||
      Object.entries(customMetadata).some(([name, value]) => metadata.metadata?.[name] !== value)
    ) {
      throw new Error(`GCS wiki artifact metadata mismatch for ${key}`);
    }
    if (collided) {
      const [existing] = await bucket.file(key, { generation: requiredGeneration(metadata) }).download();
      if (existing.byteLength !== content.byteLength || artifactSha256(existing) !== artifactSha256(content)) {
        throw new Error(`GCS wiki artifact key collision for ${key}`);
      }
    }
    return metadata;
  }

  private async readExact(ref: {
    key: string;
    uri: string;
    objectGeneration: string;
    contentType: string;
    bytes: number;
    sha256: string;
  }): Promise<Uint8Array> {
    if (ref.uri !== this.uri(ref.key)) throw new Error("GCS wiki artifact URI does not match its key");
    const file = this.#storage.bucket(this.#bucketName).file(ref.key, { generation: ref.objectGeneration });
    const [metadata] = await file.getMetadata();
    if (
      requiredGeneration(metadata) !== ref.objectGeneration ||
      Number(metadata.size) !== ref.bytes ||
      metadata.contentType !== ref.contentType ||
      metadata.metadata?.sha256 !== ref.sha256
    ) {
      throw new Error("GCS wiki artifact metadata does not match its immutable reference");
    }
    const [content] = await file.download();
    if (content.byteLength !== ref.bytes || artifactSha256(content) !== ref.sha256) {
      throw new Error("GCS wiki artifact bytes do not match their immutable reference");
    }
    return content;
  }

  private uri(key: string): string {
    return `gs://${this.#bucketName}/${key}`;
  }
}

function requiredGeneration(metadata: FileMetadata): string {
  const generation = String(metadata.generation ?? "");
  if (!/^[1-9][0-9]*$/.test(generation)) throw new Error("GCS wiki artifact generation is invalid");
  return generation;
}

function statusCode(error: unknown): number {
  return typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
}
