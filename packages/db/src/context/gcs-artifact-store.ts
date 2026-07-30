import { Storage, type FileMetadata } from "@google-cloud/storage";
import {
  artifactBytes,
  artifactSha256,
  contextArtifactKey,
  isCanonicalContextArtifactKey,
  type ContextArtifactKind,
  type ContextArtifactRef,
  type ContextArtifactStore,
  type ContextArtifactWrite
} from "@jina/context-engine";

const DURABLE_CONTEXT_ARTIFACT_KINDS = new Set<ContextArtifactKind>(["context-release"]);

export class GcsContextArtifactStore implements ContextArtifactStore {
  readonly #storage: Storage;
  readonly #bucketName: string;

  constructor(
    bucketName: string,
    options: {
      readonly projectId?: string;
      readonly keyFilename?: string;
      readonly storage?: Storage;
    } = {}
  ) {
    if (!bucketName.trim() || bucketName !== bucketName.trim() || /[/?#\\\s\0]/.test(bucketName)) {
      throw new Error("GCS artifact bucket is invalid");
    }
    this.#bucketName = bucketName;
    this.#storage =
      options.storage ??
      new Storage({
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.keyFilename ? { keyFilename: options.keyFilename } : {})
      });
  }

  async put(input: ContextArtifactWrite): Promise<ContextArtifactRef> {
    const key = contextArtifactKey(input);
    const content = artifactBytes(input.content);
    const sha256 = artifactSha256(content);
    const bucket = this.#storage.bucket(this.#bucketName);
    const file = bucket.file(key);
    let collided = false;
    try {
      await file.save(Buffer.from(content), {
        resumable: content.byteLength >= 5 * 1024 * 1024,
        validation: "crc32c",
        metadata: {
          contentType: input.contentType,
          // Bucket lifecycle expires objects only when customTime is present.
          // Certified releases are the immutable cross-build seed and must
          // remain readable for as long as the database exposes that release.
          ...(DURABLE_CONTEXT_ARTIFACT_KINDS.has(input.kind) ? {} : { customTime: new Date().toISOString() }),
          metadata: {
            sha256,
            tenantId: input.tenantId,
            repository: input.repository,
            buildId: input.buildId,
            kind: input.kind
          }
        },
        preconditionOpts: { ifGenerationMatch: 0 }
      });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
      if (code !== 412) throw error;
      collided = true;
    }
    const [metadata] = await file.getMetadata();
    this.assertWriteMetadata(metadata, input, content, sha256, key);
    if (collided) {
      const generation = requiredGeneration(metadata);
      const [existing] = await bucket.file(key, { generation }).download();
      if (existing.byteLength !== content.byteLength || artifactSha256(existing) !== sha256) {
        throw new Error(`GCS artifact key collision for ${key}`);
      }
    }
    return {
      uri: this.uri(key),
      key,
      contentType: input.contentType,
      bytes: content.byteLength,
      sha256,
      ...(metadata.generation ? { objectGeneration: String(metadata.generation) } : {})
    };
  }

  async get(ref: ContextArtifactRef): Promise<Uint8Array> {
    if (!isCanonicalContextArtifactKey(ref.key)) throw new Error("GCS artifact key is not canonical");
    if (ref.uri !== this.uri(ref.key)) throw new Error("GCS artifact URI does not match its key");
    if (!ref.objectGeneration || !/^[1-9][0-9]*$/.test(ref.objectGeneration)) {
      throw new Error("GCS artifact generation is required");
    }
    const file = this.#storage
      .bucket(this.#bucketName)
      // GCS generations exceed JavaScript's safe integer range in normal use.
      // Preserve the opaque decimal string or a resume can fetch the wrong
      // generation (or fail to find the immutable checkpoint at all).
      .file(ref.key, { generation: ref.objectGeneration });
    const [metadata] = await file.getMetadata();
    if (
      requiredGeneration(metadata) !== ref.objectGeneration ||
      Number(metadata.size) !== ref.bytes ||
      metadata.contentType !== ref.contentType ||
      metadata.metadata?.sha256 !== ref.sha256
    ) {
      throw new Error("GCS artifact metadata does not match its immutable reference");
    }
    const [content] = await file.download();
    if (content.byteLength !== ref.bytes || artifactSha256(content) !== ref.sha256) {
      throw new Error(`GCS artifact bytes do not match their immutable reference`);
    }
    return content;
  }

  private uri(key: string): string {
    return `gs://${this.#bucketName}/${key}`;
  }

  private assertWriteMetadata(
    metadata: FileMetadata,
    input: ContextArtifactWrite,
    content: Uint8Array,
    sha256: string,
    key: string
  ): void {
    requiredGeneration(metadata);
    if (
      Number(metadata.size) !== content.byteLength ||
      metadata.contentType !== input.contentType ||
      metadata.metadata?.sha256 !== sha256 ||
      metadata.metadata?.tenantId !== input.tenantId ||
      metadata.metadata?.repository !== input.repository ||
      metadata.metadata?.buildId !== input.buildId ||
      metadata.metadata?.kind !== input.kind
    ) {
      throw new Error(`GCS artifact metadata mismatch for ${key}`);
    }
  }
}

function requiredGeneration(metadata: FileMetadata): string {
  const generation = String(metadata.generation ?? "");
  if (!/^[1-9][0-9]*$/.test(generation)) throw new Error("GCS artifact generation is invalid");
  return generation;
}
